import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("two errors then a success raise a lesson nudge", () => {
  const s = session();
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", false);
  assert.equal(s.endTurn(idle), "lesson");
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
  s.recalled.add("D1");
  s.pendingNudge = "lesson";
  s.snapshot = { section: "x", files: [] };
  s.reset();
  assert.equal(s.handoffShown, false);
  assert.equal(s.recalled.size, 0);
  assert.equal(s.pendingNudge, undefined);
  assert.equal(s.snapshot, undefined);
});
