import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FILES_REASON, guardToolCall, MANAGED_WARNING } from "./guard.ts";
import { appendManaged } from "./store.ts";

const home = "/Users/me";
const roots = [`${home}/.pi/agent/pi-notebook`];
const base = { cwd: "/repo", roots, agentsFiles: [], home };
const BLOCK = { action: "block", reason: FILES_REASON };
const WARN = { action: "warn", reason: MANAGED_WARNING };

test("blocks file tools inside notebooks", () => {
  const call = (toolName: string, path: string) => guardToolCall({ ...base, toolName, input: { path } });
  assert.deepEqual(call("read", ".pi/notebook/decisions/0001-x.md"), BLOCK);
  assert.deepEqual(call("ls", "/repo/.pi/notebook"), BLOCK);
  assert.deepEqual(call("edit", "/other/.pi/notebook/handoff.md"), BLOCK);
  assert.deepEqual(call("write", "~/.pi/agent/pi-notebook/global/lessons/0001-x.md"), BLOCK);
  assert.deepEqual(call("grep", `${home}/.pi/agent/pi-notebook`), BLOCK);
  assert.equal(call("read", "src/notebook.ts"), undefined);
  assert.equal(call("read", ".pi/settings.json"), undefined);
  assert.equal(call("read", "/Code/pi-notebook/src/index.ts"), undefined);
});

test("blocks shell commands touching notebooks", () => {
  const bash = (command: string) => guardToolCall({ ...base, toolName: "bash", input: { command } });
  assert.deepEqual(bash("cat .pi/notebook/handoff.md"), BLOCK);
  assert.deepEqual(bash("rm -rf ~/.pi/agent/pi-notebook/global"), BLOCK);
  assert.deepEqual(bash(`ls ${home}/.pi/agent/pi-notebook`), BLOCK);
  assert.deepEqual(bash("sed -i '' x \"/repo/.pi/notebook/lessons/a.md\""), BLOCK);
  assert.equal(bash("cd ~/Code/Personal/pi-notebook && npm test"), undefined);
  assert.equal(bash("ls .pi/skills"), undefined);
});

test("warns on changes to the managed AGENTS.md section only", () => {
  const dir = mkdtempSync(join(tmpdir(), "nb-guard-"));
  const file = join(dir, "AGENTS.md");
  appendManaged(file, "## Preferences", "use pnpm");
  const src = readFileSync(file, "utf8");
  const g = (toolName: string, input: Record<string, unknown>) =>
    guardToolCall({ ...base, cwd: dir, agentsFiles: [file], toolName, input: { path: "AGENTS.md", ...input } });

  assert.deepEqual(g("edit", { edits: [{ oldText: "- use pnpm", newText: "- use npm" }] }), WARN);
  assert.equal(g("edit", { edits: [{ oldText: "## Preferences", newText: "## Prefs" }] }), undefined);
  assert.deepEqual(g("write", { content: "# fresh" }), WARN);
  assert.equal(g("write", { content: `# Intro\n\n${src}` }), undefined);
  assert.equal(g("read", {}), undefined);
});
