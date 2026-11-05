import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FILES_REASON,
  guardToolCall,
  managedWriteChanged,
} from "./guard.ts";
import { appendManaged } from "./store.ts";

const home = "/Users/me";
const roots = [`${home}/.pi/agent/pi-notebook`];
const base = { cwd: "/repo", roots, agentsFiles: [], home };
const BLOCK = { action: "block", reason: FILES_REASON };

test("allows notebook reading and browsing but routes model file writes through tools", () => {
  const call = (toolName: string, path: string) =>
    guardToolCall({ ...base, toolName, input: { path } });
  assert.equal(call("read", ".pi/notebook/memories/0001-x.md"), undefined);
  assert.equal(call("ls", "/repo/.pi/notebook"), undefined);
  assert.deepEqual(call("edit", "/other/.pi/notebook/handoff.md"), BLOCK);
  assert.deepEqual(
    call("write", "~/.pi/agent/pi-notebook/global/memories/0001-x.md"),
    BLOCK,
  );
  assert.equal(call("grep", `${home}/.pi/agent/pi-notebook`), undefined);
  assert.equal(call("read", "src/notebook.ts"), undefined);
  assert.equal(call("read", ".pi/settings.json"), undefined);
  assert.equal(call("read", "/Code/pi-notebook/src/index.ts"), undefined);
});

test("shell reading and browsing do not trigger notebook guard warnings", () => {
  const bash = (command: string) =>
    guardToolCall({ ...base, toolName: "bash", input: { command } });
  assert.equal(bash("cat .pi/notebook/handoff.md"), undefined);
  assert.equal(bash(`ls ${home}/.pi/agent/pi-notebook`), undefined);
  assert.equal(bash("cd ~/Code/Personal/pi-notebook && npm test"), undefined);
  assert.equal(bash("ls .pi/skills"), undefined);
});

test("verifies the managed AGENTS.md section against the resulting file", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nb-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "AGENTS.md");
  appendManaged(file, "## Preferences", "use pnpm");
  const src = readFileSync(file, "utf8");
  const g = (toolName: string, input: Record<string, unknown>) =>
    guardToolCall({
      ...base,
      cwd: dir,
      agentsFiles: [file],
      toolName,
      input: { path: "AGENTS.md", ...input },
    });

  const verdict = g("edit", { edits: [{ oldText: "- use pnpm", newText: "- use npm" }] });
  assert.equal(verdict?.action, "verify");
  if (verdict?.action !== "verify") assert.fail("Expected a managed section snapshot");
  assert.equal(managedWriteChanged(verdict.snapshot), false);
  writeFileSync(file, src.replace("## Preferences", "## Prefs"));
  assert.equal(managedWriteChanged(verdict.snapshot), false);
  writeFileSync(file, src.replace("- use pnpm", "- use npm"));
  assert.equal(managedWriteChanged(verdict.snapshot), true);
  writeFileSync(file, "# fresh");
  assert.equal(managedWriteChanged(verdict.snapshot), true);

  const created = g("write", { content: src });
  assert.equal(created?.action, "verify");
  if (created?.action !== "verify") assert.fail("Expected a managed section snapshot");
  writeFileSync(file, src);
  assert.equal(managedWriteChanged(created.snapshot), true);
  assert.equal(g("read", {}), undefined);
});
