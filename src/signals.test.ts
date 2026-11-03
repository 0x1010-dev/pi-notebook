import assert from "node:assert/strict";
import { test } from "node:test";
import { bandIndex, bandText, COMMIT_RE, looksLikePreference, looksLikeResume, MILESTONE_NUDGE } from "./signals.ts";

test("resume detection", () => {
  for (const text of ["Where did we end up yesterday?", "What's the plan for today?", "let's continue", "catch me up"])
    assert.ok(looksLikeResume(text));
  for (const text of ["fix the failing test", "run git status"]) assert.ok(!looksLikeResume(text));
});

test("preference detection requires lasting language", () => {
  for (const text of ["From now on use pnpm", "I prefer tabs", "never use em-dashes"])
    assert.ok(looksLikePreference(text));
  for (const text of ["fix the failing test", "don't break the build", "this always fails on CI", "use X instead of Y here"])
    assert.ok(!looksLikePreference(text));
});

test("commit detection", () => {
  assert.ok(COMMIT_RE.test('git commit -m "x"'));
  assert.ok(COMMIT_RE.test("git -C repo commit -am wip"));
  assert.ok(!COMMIT_RE.test("git status && echo commit"));
});

test("nudges explicitly permit saving nothing and avoid memory quotas", () => {
  assert.match(MILESTONE_NUDGE, /Otherwise ignore/);
});

test("bandIndex finds the highest reached threshold", () => {
  const bands = [50, 70, 85];
  assert.equal(bandIndex(40, bands), -1);
  assert.equal(bandIndex(50, bands), 0);
  assert.equal(bandIndex(65, bands), 0);
  assert.equal(bandIndex(70, bands), 1);
  assert.equal(bandIndex(85, bands), 2);
  assert.equal(bandIndex(99, bands), 2);
  assert.equal(bandIndex(50, []), -1);
});

test("bandText matches each band's exact wording", () => {
  const handoff = { handoff: true, compactTool: false };
  assert.equal(
    bandText(50.4, 0, handoff),
    "[pi-notebook] Context window 50% full. Consider saving any durable knowledge worth keeping.",
  );
  assert.equal(
    bandText(70, 1, handoff),
    "[pi-notebook] Context window 70% full. Consider updating the handoff if progress has changed.",
  );
  assert.equal(
    bandText(85, 2, handoff),
    "[pi-notebook] Context window 85% full. Compaction is near. At the next clean stopping point, update the handoff.",
  );
  assert.equal(
    bandText(85, 2, { handoff: true, compactTool: true }),
    "[pi-notebook] Context window 85% full. Compaction is near. At the next clean stopping point, update the handoff and call context_compact.",
  );
});

test("bandText falls back to the band 0 wording without a project handoff", () => {
  const noHandoff = { handoff: false, compactTool: false };
  assert.equal(
    bandText(85, 2, noHandoff),
    "[pi-notebook] Context window 85% full. Consider saving any durable knowledge worth keeping.",
  );
});
