import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "./session.ts";

// Config loads from here, so the user's real settings.json cannot affect the tests.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "nb-session-"));

const idle = { contextPercent: 0, handoffMissing: false };

function session(): Session {
  const s = new Session();
  s.reset();
  return s;
}

test("a commit raises a milestone nudge once, then it is consumed", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  assert.equal(s.endTurn(idle), "milestone");
  s.recordToolResult("bash", "git status", false);
  assert.notEqual(s.endTurn(idle), "milestone");
});

test("failed commits do not count", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", true);
  assert.equal(s.endTurn(idle), undefined);
});

test("tool retries do not manufacture a memory-writing obligation", () => {
  const s = session();
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", false);
  assert.equal(s.endTurn(idle), undefined);
});

test("context nudge fires once until compaction", () => {
  const s = session();
  const high = { contextPercent: 90, handoffMissing: false };
  assert.equal(s.endTurn(high), "context");
  assert.equal(s.endTurn(high), undefined);
  s.onCompact();
  assert.equal(s.endTurn(high), "context");
});

test("saving resets nudge counters", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  s.markSaved();
  assert.equal(s.endTurn(idle), undefined);
});

test("reset clears per-session state", () => {
  const s = session();
  s.handoffShown = true;
  s.recalled.set("M1", "revision");
  s.pendingNudge = "milestone";
  s.snapshot = { section: "x", files: [] };
  s.reset();
  assert.equal(s.handoffShown, false);
  assert.equal(s.recalled.size, 0);
  assert.equal(s.pendingNudge, undefined);
  assert.equal(s.snapshot, undefined);
});

test("compaction resets recalled revisions so dropped memories can return", () => {
  const s = session();
  s.recalled.set("M1", "revision");
  s.handoffShown = true;
  s.onCompact();
  assert.equal(s.recalled.size, 0);
  assert.equal(s.handoffShown, false);
});
