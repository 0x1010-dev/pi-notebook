import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CompactOptions, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionEvents } from "./events/compaction.ts";
import { registerContextEvents } from "./events/context.ts";
import { projectScope } from "./paths.ts";
import type { Runtime } from "./runtime.ts";
import { Session } from "./session.ts";
import { initScope, writeHandoff } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "nb-events-"));
after(() => rmSync(root, { recursive: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let next = 0;

type Handler = (event: any, ctx: ExtensionContext) => Promise<any>;

function harness({ handoff = true, nextSteps = ["Finish"] } = {}) {
  const cwd = join(root, `project-${++next}`);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const scope = projectScope({ root: cwd, name: "test" }, "repo");
  initScope(scope);
  if (handoff)
    writeHandoff(scope, {
      goal: "Migrate handlers", status: "Half done", nextSteps,
      blockers: [], notes: "", updated: new Date().toISOString(),
    });
  const handlers = new Map<string, Handler>();
  const sent: { message: unknown; options: unknown }[] = [];
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    sendMessage(message: unknown, options: unknown) { sent.push({ message, options }); },
  } as unknown as ExtensionAPI;
  const session = new Session();
  session.reset();
  const rt: Runtime = { pi, session, refreshStatus() {}, markSaved() {}, sendOwnPrompt() {} };
  registerCompactionEvents(rt);
  registerContextEvents(rt);
  let usage: { percent: number | null } | undefined;
  const compactions: CompactOptions[] = [];
  const ctx = {
    cwd, hasUI: false,
    getContextUsage: () => usage && { tokens: null, contextWindow: 100, ...usage },
    compact: (opts: CompactOptions) => { compactions.push(opts); },
  } as unknown as ExtensionContext;
  return {
    session, sent, compactions,
    setUsage(percent: number | null | undefined) { usage = percent === undefined ? undefined : { percent }; },
    emit: (name: string, event: object) => handlers.get(name)!(event, ctx),
  };
}

const beforeCompact = { preparation: { firstKeptEntryId: "e42", tokensBefore: 150_000 } };

test("session_before_compact leaves pi's summary alone when disabled or without a handoff", async () => {
  assert.equal(await harness().emit("session_before_compact", beforeCompact), undefined);
  const h = harness({ handoff: false });
  h.session.cfg.handoffCompaction = true;
  assert.equal(await h.emit("session_before_compact", beforeCompact), undefined);
});

test("session_before_compact uses a fresh handoff as the summary", async () => {
  const h = harness();
  h.session.cfg.handoffCompaction = true;
  h.session.markHandoff();
  const result = await h.emit("session_before_compact", beforeCompact);
  assert.match(result.compaction.summary, /Migrate handlers/);
  assert.doesNotMatch(result.compaction.summary, /out of date/);
  assert.equal(result.compaction.firstKeptEntryId, "e42");
  assert.equal(result.compaction.tokensBefore, 150_000);
  assert.equal(h.session.handoffCompacted, true);
});

test("a stale handoff is still used, with a warning", async () => {
  const h = harness();
  h.session.cfg.handoffCompaction = true;
  const result = await h.emit("session_before_compact", beforeCompact);
  assert.match(result.compaction.summary, /may be out of date/);
});

test("context bands append one hidden note at the current band", async () => {
  const h = harness();
  const messages = [{ role: "user", content: "hi" }];
  h.setUsage(40);
  assert.equal(await h.emit("context", { messages }), undefined);
  h.setUsage(72);
  const result = await h.emit("context", { messages });
  assert.equal(result.messages.length, 2);
  const note = result.messages.at(-1);
  assert.equal(note.role, "custom");
  assert.equal(note.display, false);
  assert.match(note.content, /updating the handoff/);
  assert.equal(messages.length, 1);
});

test("context bands are skipped without usage or with nudges off", async () => {
  const h = harness();
  const messages = [{ role: "user", content: "hi" }];
  h.setUsage(undefined);
  assert.equal(await h.emit("context", { messages }), undefined);
  h.setUsage(null);
  assert.equal(await h.emit("context", { messages }), undefined);
  h.setUsage(90);
  h.session.cfg.nudgeModel = false;
  assert.equal(await h.emit("context", { messages }), undefined);
});

test("the compaction band mentions context_compact only when it is offered", async () => {
  const h = harness();
  const messages = [{ role: "user", content: "hi" }];
  h.setUsage(90);
  let result = await h.emit("context", { messages });
  assert.doesNotMatch(result.messages.at(-1).content, /context_compact/);
  h.session.cfg.handoffCompaction = true;
  result = await h.emit("context", { messages });
  assert.match(result.messages.at(-1).content, /context_compact/);
});

test("a scheduled compaction runs when the agent settles, then resumes the work", async () => {
  const h = harness();
  h.session.compactPending = true;
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.compactions.length, 1);
  h.session.onCompact();
  h.compactions[0].onComplete?.(undefined as never);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].options, { triggerTurn: true });
  assert.equal(h.session.compactCycles, 1);
});

test("an interrupted run neither compacts nor resumes", async () => {
  const h = harness();
  h.session.compactPending = true;
  h.session.resumePending = true;
  await h.emit("agent_settled", { aborted: true });
  assert.equal(h.compactions.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.session.compactPending, false);
  assert.equal(h.session.resumePending, false);
});

test("resume stops when the work is done or the cycle cap is reached", async () => {
  const done = harness({ nextSteps: [] });
  done.session.resumePending = true;
  await done.emit("agent_settled", { aborted: false });
  assert.equal(done.sent.length, 0);

  const capped = harness();
  capped.session.compactCycles = capped.session.cfg.maxCompactCycles;
  capped.session.resumePending = true;
  await capped.emit("agent_settled", { aborted: false });
  assert.equal(capped.sent.length, 0);
  assert.equal(capped.session.resumePending, false);
});
