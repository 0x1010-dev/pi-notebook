import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "./session.ts";

// Config loads from here, so the user's real settings.json cannot affect the tests.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "nb-session-"));

const idle = { contextPercent: 0 };

function session(): Session {
  const s = new Session();
  s.reset();
  return s;
}

test("a commit raises a milestone nudge once, then it is consumed", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  assert.equal(s.endTurn(idle), true);
  s.recordToolResult("bash", "git status", false);
  assert.equal(s.endTurn(idle), false);
});

test("milestone nudges respect the cooldown", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  assert.equal(s.endTurn(idle), true);
  s.recordToolResult("bash", "git commit -m y", false);
  for (let i = 1; i < s.cfg.nudgeCooldownTurns; i++) assert.equal(s.endTurn(idle), false);
  assert.equal(s.endTurn(idle), true);
});

test("failed commits do not count", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", true);
  assert.equal(s.endTurn(idle), false);
});

test("tool retries do not manufacture a memory-writing obligation", () => {
  const s = session();
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", true);
  s.recordToolResult("bash", "a", false);
  assert.equal(s.endTurn(idle), false);
});

test("context at or above the handoff band suppresses the milestone nudge and clears the commit", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  const high = { contextPercent: s.cfg.contextBands[1] };
  assert.equal(s.endTurn(high), false);
  // the band already asked for a handoff, so the commit obligation is cleared, not deferred
  assert.equal(s.endTurn(high), false);
});

test("handoffFresh tracks turns since this session last saved the handoff", () => {
  const s = session();
  assert.equal(s.handoffFresh(), false);
  s.markHandoff();
  assert.equal(s.handoffFresh(), true);
  for (let i = 0; i < s.cfg.handoffStaleTurns; i++) s.endTurn(idle);
  assert.equal(s.handoffFresh(), true);
  s.endTurn(idle);
  assert.equal(s.handoffFresh(), false);
});

test("onCompact shows the handoff once when it was the compaction summary, otherwise hides it", () => {
  const s = session();
  s.handoffCompacted = true;
  s.onCompact();
  assert.equal(s.handoffShown, true);
  assert.equal(s.handoffCompacted, false);

  s.handoffShown = true;
  s.onCompact();
  assert.equal(s.handoffShown, false);
});

test("a scheduled compaction becomes a pending resume once it completes", () => {
  const s = session();
  s.onCompact();
  assert.equal(s.resumePending, false);
  s.compactPending = true;
  s.onCompact();
  assert.equal(s.resumePending, true);
  assert.equal(s.compactPending, false);
});

test("a failed compaction clears the scheduled compaction and summary marker", () => {
  const s = session();
  s.compactPending = true;
  s.handoffCompacted = true;
  s.onCompactFailed();
  assert.equal(s.compactPending, false);
  assert.equal(s.handoffCompacted, false);
});

test("saving resets nudge counters", () => {
  const s = session();
  s.recordToolResult("bash", "git commit -m x", false);
  s.markSaved();
  assert.equal(s.endTurn(idle), false);
});

test("reset clears per-session state", () => {
  const s = session();
  s.handoffShown = true;
  s.recalled.set("M1", "revision");
  s.pendingNudge = true;
  s.snapshot = { section: "x", files: [] };
  s.reset();
  assert.equal(s.handoffShown, false);
  assert.equal(s.recalled.size, 0);
  assert.equal(s.pendingNudge, false);
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
