import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
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
import { registerMemoryRetire } from "./tools/memory-retire.ts";

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
  const ctx = partialMock<ExtensionToolContext>({
    cwd, hasUI: true,
    ui: partialMock<ExtensionToolContext["ui"]>({
      async confirm() { confirms++; return accepted; },
    }),
  });
  registerMemorySave(rt);
  registerMemorySearch(rt);
  registerHandoffUpdate(rt);
  registerMemoryRetire(rt);
  return {
    session, ctx,
    get confirms() { return confirms; },
    decline() { accepted = false; },
    async call(name: string, args: Record<string, unknown>) {
      const tool = tools.get(name)!;
      return tool(args, ctx);
    },
  };
}

test("registered tools save, partially update, search, read and archive memories end to end", async () => {
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
  await h.call("memory_retire", { refs: ["M1"], reason: "Replaced." });
  const absent = await h.call("memory_search", { query: "#braille" });
  assert.match(JSON.stringify(absent.content), /No matches/);
  const archived = await h.call("memory_search", { query: "*", include_retired: true });
  assert.match(JSON.stringify(archived.content), /retired: Replaced/);
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
