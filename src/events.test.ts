import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createEditTool, type CompactOptions, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerCompactionEvents } from "./events/compaction.ts";
import { registerContextEvents } from "./events/context.ts";
import { registerTurnEvents } from "./events/turns.ts";
import { registerToolEvents } from "./events/tools.ts";
import { MANAGED_WARNING } from "./guard.ts";
import { projectScope } from "./paths.ts";
import type { Runtime } from "./runtime.ts";
import { Session } from "./session.ts";
import { appendManaged, initScope, writeHandoff } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "nb-events-"));
after(() => rmSync(root, { recursive: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let next = 0;

type Handler = (event: any, ctx: ExtensionContext) => Promise<any>;

function harness({ handoff = true, nextSteps = ["Finish"], hasUI = false } = {}) {
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
  registerTurnEvents(rt);
  registerToolEvents(rt);
  let usage: { percent: number | null } | undefined;
  const compactions: CompactOptions[] = [];
  const notifications: { message: string; type: string }[] = [];
  const ctx = {
    cwd, hasUI,
    ui: { notify(message: string, type: string) { notifications.push({ message, type }); } },
    getContextUsage: () => usage && { tokens: null, contextWindow: 100, ...usage },
    compact: (opts: CompactOptions) => { compactions.push(opts); },
  } as unknown as ExtensionContext;
  return {
    session, sent, compactions, scope, notifications,
    setUsage(percent: number | null | undefined) { usage = percent === undefined ? undefined : { percent }; },
    emit: (name: string, event: object) => handlers.get(name)!(event, ctx),
  };
}

const beforeCompact = { preparation: { firstKeptEntryId: "e42", tokensBefore: 150_000 } };

test("file-tool results warn only for actual managed section changes", async () => {
  const h = harness({ hasUI: true });
  const file = h.scope.agentsFile;
  appendManaged(file, "## Preferences", "use pnpm");
  const src = readFileSync(file, "utf8");
  writeFileSync(file, `# Human notes\n- use pnpm\n\n${src}`);
  const edit = createEditTool(h.scope.project!.root);
  const call = async (oldText: string, newText: string) => {
    const input = { path: file, edits: [{ oldText, newText }] };
    assert.equal(await h.emit("tool_call", { toolName: "edit", toolCallId: "edit", input }), undefined);
    const result = await edit.execute("edit", input);
    const event = { toolName: "edit", toolCallId: "edit", input, isError: false, ...result };
    const warning = await h.emit("tool_result", event);
    assert.equal(h.session.managedWrites.size, 0);
    if (warning) assert.deepEqual(warning.content, [...result.content, { type: "text", text: MANAGED_WARNING }]);
    return warning;
  };

  // Matching text outside the block is not a managed section change.
  assert.equal(await call("# Human notes\n- use pnpm", "# Human notes\n- use npm"), undefined);
  // Pi accepts a fuzzy match with trailing whitespace absent from the file.
  assert.ok(await call("- use pnpm  ", "- use yarn"));
  assert.deepEqual(h.notifications, [{ message: MANAGED_WARNING, type: "warning" }]);
});

test("write results detect managed section creation and removal, but skip failed calls", async () => {
  const h = harness();
  const file = h.scope.agentsFile;
  const input = { path: file, content: "# Human notes\n" };
  const start = () => h.emit("tool_call", { toolName: "write", toolCallId: "write", input });
  const finish = (isError = false) => h.emit("tool_result", {
    toolName: "write", toolCallId: "write", input, isError,
    content: [{ type: "text", text: "result" }],
  });
  writeFileSync(file, input.content);
  await start();
  appendManaged(file, "## Preferences", "use pnpm");
  assert.ok(await finish());
  await start();
  const src = readFileSync(file, "utf8");
  writeFileSync(file, `# More human notes\n${src}`);
  assert.equal(await finish(), undefined);
  await start();
  assert.equal(await finish(true), undefined);
  assert.equal(h.session.managedWrites.size, 0);
  assert.equal(await finish(), undefined);
  await start();
  writeFileSync(file, input.content);
  assert.ok(await finish());

  h.session.cfg.guard = false;
  await start();
  appendManaged(file, "## Preferences", "use npm");
  assert.equal(await finish(), undefined);
});

test("session_before_compact leaves pi's summary alone when disabled or without a handoff", async () => {
  const off = harness();
  off.session.cfg.handoffCompaction = false;
  assert.equal(await off.emit("session_before_compact", beforeCompact), undefined);
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

test("session_before_compact falls back to pi's summary for malformed handoffs", async () => {
  const h = harness();
  writeFileSync(join(h.scope.dir, "handoff.md"), "---\nupdated: [broken\n---\n# Current handoff\n");
  assert.equal(await h.emit("session_before_compact", beforeCompact), undefined);
  assert.equal(h.session.handoffCompacted, false);
});

test("a stale handoff is still used, with a warning", async () => {
  const h = harness();
  h.session.cfg.handoffCompaction = true;
  const result = await h.emit("session_before_compact", beforeCompact);
  assert.match(result.compaction.summary, /may be out of date/);
});

test("each request past the compaction band carries only a bare usage line", async () => {
  const h = harness();
  const messages = [{ role: "user", content: "hi" }];
  h.setUsage(60);
  assert.equal(await h.emit("context", { messages }), undefined);
  h.setUsage(77.4);
  const result = await h.emit("context", { messages });
  assert.equal(result.messages.length, 2);
  const note = result.messages.at(-1);
  assert.equal(note.role, "custom");
  assert.equal(note.display, false);
  assert.equal(note.content, "[pi-notebook] Context window 77% full.");
  assert.equal(messages.length, 1);
});

test("the usage line is skipped without usage or with nudges off", async () => {
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

const midRun = { toolResults: [{}] };

test("named thresholds control reminders independently of defaults", async () => {
  const h = harness();
  h.session.cfg.contextBands = { save: 20, handoff: 30, compact: 40 };
  h.setUsage(20);
  assert.match((await h.emit("turn_end", midRun)).entries[0].content, /durable knowledge/);
  h.setUsage(30);
  assert.match((await h.emit("turn_end", midRun)).entries[0].content, /updating the handoff/);
  assert.equal(await h.emit("context", { messages: [] }), undefined);
  h.setUsage(40);
  assert.match((await h.emit("turn_end", midRun)).entries[0].content, /Compaction is near/);
  assert.match((await h.emit("context", { messages: [] })).messages[0].content, /40% full/);
});

test("false disables context reminders without disabling milestone nudges", async () => {
  const h = harness();
  h.session.cfg.contextBands = false;
  h.setUsage(100);
  assert.equal(await h.emit("context", { messages: [] }), undefined);
  assert.equal(await h.emit("turn_end", midRun), undefined);
  assert.equal(h.session.pendingNudge, undefined);
  h.session.recordToolResult("bash", "git commit -m x", false);
  assert.equal(h.session.endTurn({ contextPercent: 100 }), true);
});

test("a band suggestion is sent once per band until compaction", async () => {
  const h = harness();
  h.setUsage(60);
  const first = await h.emit("turn_end", midRun);
  assert.match(first.entries[0].content, /updating the handoff/);
  h.setUsage(62);
  assert.equal(await h.emit("turn_end", midRun), undefined);
  h.session.onCompact();
  h.setUsage(60);
  assert.match((await h.emit("turn_end", midRun)).entries[0].content, /updating the handoff/);
});

test("jumping past several bands sends only the highest", async () => {
  const h = harness();
  h.setUsage(90);
  const result = await h.emit("turn_end", midRun);
  assert.match(result.entries[0].content, /Compaction is near/);
  assert.doesNotMatch(result.entries[0].content, /durable knowledge/);
});

test("a band crossed on the final turn waits for the next prompt", async () => {
  const h = harness();
  h.setUsage(45);
  assert.equal(await h.emit("turn_end", { toolResults: [] }), undefined);
  assert.match(h.session.pendingNudge!, /durable knowledge/);
});

test("the compaction band mentions context_compact only when it is offered", async () => {
  const off = harness();
  off.session.cfg.handoffCompaction = false;
  off.setUsage(90);
  assert.doesNotMatch((await off.emit("turn_end", midRun)).entries[0].content, /context_compact/);
  const on = harness();
  on.setUsage(90);
  assert.match((await on.emit("turn_end", midRun)).entries[0].content, /context_compact/);
});

test("a scheduled compaction runs when the agent settles, then resumes the work", async () => {
  const h = harness();
  h.session.compactPending = true;
  h.setUsage(null);
  await h.emit("agent_settled", { aborted: false });
  assert.equal(h.compactions.length, 1);
  h.session.onCompact();
  h.compactions[0].onComplete?.({ estimatedTokensAfter: 15 } as never);
  assert.equal(h.sent.length, 1);
  assert.match((h.sent[0].message as { content: string }).content, /Context window is now 15% full/);
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
