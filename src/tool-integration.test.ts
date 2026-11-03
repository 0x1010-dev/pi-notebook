import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Assert } from "typebox/value";
import { locate, type Runtime } from "./runtime.ts";
import { Session } from "./session.ts";
import { getEntry, initScope, listAll, readHandoff, readManaged } from "./store.ts";
import { projectScope } from "./paths.ts";
import { registerMemorySave } from "./tools/memory-save.ts";
import { registerMemorySearch } from "./tools/memory-search.ts";
import { registerHandoffUpdate } from "./tools/handoff-update.ts";
import { registerMemoryDelete } from "./tools/memory-delete.ts";
import { registerContextCompact } from "./tools/context-compact.ts";

const root = mkdtempSync(join(tmpdir(), "nb-tools-"));
after(() => rmSync(root, { recursive: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let next = 0;

/** Unused SDK surfaces fail loudly instead of returning success-shaped mock values. */
function partialMock<T extends object>(parts: Partial<T>): T {
  return new Proxy(parts, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected mock access: ${String(key)}`);
    },
  }) as T;
}

function harness() {
  const cwd = join(root, `project-${++next}`);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  initScope(projectScope({ root: cwd, name: "test" }, "repo"));
  const tools = new Map<string, (args: Record<string, unknown>, ctx: ExtensionToolContext) => Promise<{ content: unknown }>>();
  const pi = partialMock<ExtensionAPI>({
    registerTool(tool) {
      tools.set(tool.name, async (args, ctx) => {
        const prepared: unknown = tool.prepareArguments ? tool.prepareArguments(args) : args;
        Assert(tool.parameters, prepared);
        // The SDK resolves a separate TypeBox copy; the shared JSON schema validates this boundary.
        return tool.execute("test", prepared as Parameters<typeof tool.execute>[1], undefined, undefined, ctx);
      });
    },
  });
  const session = new Session();
  session.reset();
  const rt: Runtime = {
    pi, session, refreshStatus() {}, sendOwnPrompt() {},
    markSaved() { session.markSaved(); },
  };
  let confirms = 0;
  let accepted = true;
  let projectOnly = false;
  let cancelled = false;
  let percent: number | null = 50;
  const selections: string[][] = [];
  const ctx = partialMock<ExtensionToolContext>({
    cwd, hasUI: true,
    getContextUsage: () => ({ tokens: null, contextWindow: 100, percent }),
    ui: partialMock<ExtensionToolContext["ui"]>({
      async confirm() { confirms++; return accepted; },
      async select(_title, options) {
        confirms++;
        selections.push(options);
        if (cancelled) return undefined;
        if (!accepted) return "Reject";
        return projectOnly && options.includes("Reject")
          ? options.find((option) => option.toLowerCase().includes("project")) : options[0];
      },
    }),
  });
  registerMemorySave(rt);
  registerMemorySearch(rt);
  registerHandoffUpdate(rt);
  registerMemoryDelete(rt);
  registerContextCompact(rt);
  return {
    session, ctx,
    get confirms() { return confirms; },
    decline() { accepted = false; },
    projectOnly() { projectOnly = true; },
    cancel() { cancelled = true; },
    setUsage(value: number | null) { percent = value; },
    selections,
    async call(name: string, args: Record<string, unknown>) {
      const tool = tools.get(name)!;
      return tool(args, ctx);
    },
  };
}

test("registered tools save, update, search, read and permanently delete memories", async () => {
  const h = harness();
  const saved = await h.call("memory_save", {
    title: "Braille rendering", content: "Use the canonical dot table.", tags: ["braille"], files: ["src/spark.rs"],
  });

  assert.match(JSON.stringify(saved.content), /Saved M1/);
  await h.call("memory_save", { ref: "M1", tags: ["braille", "tui"] });
  const entry = getEntry(locate(h.ctx.cwd).scope!, 1)!;
  assert.equal(entry.title, "Braille rendering");
  assert.equal(entry.body, "Use the canonical dot table.");
  assert.deepEqual(entry.files, ["src/spark.rs"]);
  const searched = await h.call("memory_search", { query: "#braille" });
  assert.match(JSON.stringify(searched.content), /canonical dot table/);
  const read = await h.call("memory_search", { query: "M1" });
  assert.match(JSON.stringify(read.content), /Files: src\/spark.rs/);
  await h.call("memory_delete", { refs: ["M1"], reason: "Replaced." });
  const absent = await h.call("memory_search", { query: "#braille" });
  assert.match(JSON.stringify(absent.content), /No matches/);
  const missing = await h.call("memory_search", { query: "M1" });
  assert.match(JSON.stringify(missing.content), /Not found: M1/);
  assert.deepEqual(listAll(locate(h.ctx.cwd).scope!), []);
  assert.equal(h.confirms, 1);
});

test("context_compact requires a recent handoff from this session", async () => {
  const h = harness();
  await assert.rejects(h.call("context_compact", {}), /handoff_update first/);
  await h.call("handoff_update", { goal: "Migrate", status: "Half done", next_steps: ["Finish"] });
  const scheduled = await h.call("context_compact", {});
  assert.match(JSON.stringify(scheduled.content), /Compaction scheduled/);
  assert.equal(h.session.compactPending, true);
  h.session.compactPending = false;
  for (let i = 0; i <= h.session.cfg.handoffStaleTurns; i++) h.session.endTurn({ contextPercent: 0 });
  await assert.rejects(h.call("context_compact", {}), /handoff_update first/);
  assert.equal(h.session.compactPending, false);
});

test("context_compact refuses when compaction is not needed", async () => {
  const h = harness();
  await h.call("handoff_update", { goal: "Migrate", status: "Half done", next_steps: ["Finish"] });
  h.setUsage(15.2);
  await assert.rejects(h.call("context_compact", {}), /only 15% full/);
  h.setUsage(null);
  await assert.rejects(h.call("context_compact", {}), /compaction just ran/);
  assert.equal(h.session.compactPending, false);
});

test("search reports malformed files while valid memories remain usable", async () => {
  const h = harness();
  await h.call("memory_save", { title: "SQLite choice", content: "Use SQLite." });
  const s = locate(h.ctx.cwd).scope!;
  writeFileSync(join(s.dir, "memories/0042-broken.md"), "---\ntags: [broken\n---\n# Broken\n\nContent.");
  for (const query of ["*", "sqlite", "M1", "handoff"]) {
    const result = await h.call("memory_search", { query });
    assert.match(JSON.stringify(result.content), /files need repair/);
    assert.match(JSON.stringify(result.content), /0042-broken/);
  }
  const valid = await h.call("memory_search", { query: "M1" });
  assert.match(JSON.stringify(valid.content), /Use SQLite/);
  await assert.rejects(h.call("memory_search", { query: "M42" }), /files need repair/);
  const saved = await h.call("memory_save", { title: "Next", content: "New knowledge." });
  assert.match(JSON.stringify(saved.content), /Saved M43/);
});

test("deletion requires approval and leaves memories untouched when declined", async () => {
  const h = harness();
  await h.call("memory_save", { title: "Keep", content: "Useful knowledge." });
  h.decline();
  await h.call("memory_delete", { refs: ["M1"], reason: "Obsolete" });
  assert.ok(getEntry(locate(h.ctx.cwd).scope!, 1));
  h.ctx.hasUI = false;
  await assert.rejects(h.call("memory_delete", { refs: ["M1"], reason: "Obsolete" }), /confirmation/);
});

test("confirmed deletion deduplicates refs and reports missing memories", async () => {
  const h = harness();
  await h.call("memory_save", { title: "Obsolete", content: "Old knowledge." });
  const result = await h.call("memory_delete", { refs: ["M1", "M1", "M99"], reason: "No longer true" });
  assert.match(JSON.stringify(result.content), /Deleted M1/);
  assert.match(JSON.stringify(result.content), /Not found: M99/);
  assert.equal(h.confirms, 1);
});

test("related memories advise without rejecting or forcing a duplicate retry", async () => {
  const h = harness();
  await h.call("memory_save", { title: "SQLite migrations", content: "Use transactions." });
  const saved = await h.call("memory_save", { title: "SQLite migrations", content: "Keep rollback scripts." });
  assert.match(JSON.stringify(saved.content), /Saved M2/);
  assert.match(JSON.stringify(saved.content), /Related memories/);
  assert.equal(listAll(locate(h.ctx.cwd).scope!).length, 2);
});

test("global memories and rules ask permission; declined saves write nothing", async () => {
  const h = harness();
  await h.call("memory_save", { title: "Use pnpm", kind: "rule" });
  assert.deepEqual(readManaged(locate(h.ctx.cwd).scope!.agentsFile), ["Use pnpm"]);
  await h.call("memory_save", { title: "Remote shell", content: "The remote uses zsh.", scope: "global" });
  assert.equal(h.confirms, 2);
  const before = listAll(locate(h.ctx.cwd).global).length;
  h.decline();
  await h.call("memory_save", { title: "Another global", content: "Do not persist.", scope: "global" });
  assert.equal(listAll(locate(h.ctx.cwd).global).length, before);
  h.ctx.hasUI = false;
  await assert.rejects(h.call("memory_save", { title: "No prompt", content: "Do not persist.", scope: "global" }), /confirmation/);
});

test("global proposals can be saved project-only with tags and files, without global writes", async () => {
  const h = harness();
  const global = locate(h.ctx.cwd).global;
  const before = listAll(global);
  h.projectOnly();
  const result = await h.call("memory_save", {
    title: "Deployment", content: "Restart the service after installing.",
    scope: "global", tags: ["deployment"], files: ["deploy/install.sh"],
  });
  assert.match(JSON.stringify(result.content), /for this project only/);
  const local = listAll(locate(h.ctx.cwd).scope!);
  assert.equal(local.length, 1);
  assert.deepEqual(local[0].tags, ["deployment"]);
  assert.deepEqual(local[0].files, ["deploy/install.sh"]);
  assert.deepEqual(listAll(global), before);
  assert.equal(h.confirms, 1);
});

test("global updates saved project-only copy the full proposed memory and leave the original unchanged", async () => {
  const h = harness();
  await h.call("memory_save", {
    title: "Shared tooling", content: "Original global conclusion.", tags: ["tooling"], scope: "global",
  });

  const global = locate(h.ctx.cwd).global;
  const original = listAll(global).at(-1)!;
  h.projectOnly();
  const result = await h.call("memory_save", { ref: `~M${original.id}`, content: "Project-specific conclusion." });
  assert.match(JSON.stringify(result.content), /Global memory ~M\d+ was left unchanged/);
  assert.deepEqual(getEntry(global, original.id), original);
  const local = listAll(locate(h.ctx.cwd).scope!)[0];
  assert.equal(local.title, original.title);
  assert.equal(local.body, "Project-specific conclusion.");
  assert.deepEqual(local.tags, ["tooling"]);
});

test("global approval updates the original in place rather than creating a project memory", async () => {
  const h = harness();
  await h.call("memory_save", { title: "Shared", content: "Original.", scope: "global" });
  const global = locate(h.ctx.cwd).global;
  const original = listAll(global).at(-1)!;
  await h.call("memory_save", { ref: `~M${original.id}`, content: "Updated globally." });
  assert.equal(getEntry(global, original.id)?.body, "Updated globally.");
  assert.deepEqual(listAll(locate(h.ctx.cwd).scope!), []);
  assert.equal(h.selections.at(-1)?.[0], "Update globally");
});

test("project-only saves offer notebook creation when the project has none", async () => {
  const h = harness();
  const cwd = join(root, `uninitialized-${++next}`);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  h.ctx.cwd = cwd;
  h.projectOnly();
  await h.call("memory_save", { title: "Local knowledge", content: "Only applies here.", scope: "global" });
  const scope = locate(cwd).scope;
  assert.ok(scope);
  assert.equal(listAll(scope)[0].title, "Local knowledge");
  assert.equal(h.selections.length, 2);
});

test("global rules offer project-only scope and cancelled prompts save nothing", async () => {
  const h = harness();
  const global = locate(h.ctx.cwd).global;
  const rulesBefore = readManaged(global.agentsFile);
  h.projectOnly();
  await h.call("memory_save", { title: "Use pnpm", kind: "rule", scope: "global" });
  assert.deepEqual(readManaged(locate(h.ctx.cwd).scope!.agentsFile), ["Use pnpm"]);
  assert.deepEqual(readManaged(global.agentsFile), rulesBefore);
  assert.equal(h.confirms, 1);
  h.cancel();
  await h.call("memory_save", { title: "Cancelled", content: "Do not persist.", scope: "global" });
  assert.deepEqual(listAll(locate(h.ctx.cwd).scope!), []);
});

test("global proposals outside a project do not offer a project-only option", async () => {
  const h = harness();
  h.ctx.cwd = root;
  h.cancel();
  await h.call("memory_save", { title: "Global", content: "Shared knowledge.", scope: "global" });
  assert.deepEqual(h.selections[0], ["Save globally", "Reject"]);
});

test("blank input, invalid refs and secrets surface errors without saving", async () => {
  const h = harness();
  await assert.rejects(h.call("memory_save", { title: "Empty" }), /needs content/);
  await assert.rejects(h.call("memory_save", { title: " ", content: "Some content." }), /blank/);
  await assert.rejects(h.call("memory_save", { ref: "D1", content: "Bad reference." }), /Invalid ref/);
  await assert.rejects(h.call("memory_save", { title: "Secret", content: `ghp_${"a".repeat(36)}` }), /GitHub token/);
  assert.deepEqual(listAll(locate(h.ctx.cwd).scope!), []);
});

test("handoff replacement clears obsolete fields instead of accumulating inconsistent state", async () => {
  const h = harness();
  await h.call("handoff_update", {
    goal: "Ship CLI", status: "Implementation pending", next_steps: ["Implement"], blockers: ["Review"], notes: "Old context",
  });
  await h.call("handoff_update", { goal: "Ship CLI", status: "Complete", next_steps: [] });
  const handoff = readHandoff(locate(h.ctx.cwd).scope!)!;
  assert.equal(handoff.status, "Complete");
  assert.deepEqual(handoff.nextSteps, []);
  assert.deepEqual(handoff.blockers, []);
  assert.equal(handoff.notes, "");
});
