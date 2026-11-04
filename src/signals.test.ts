import assert from "node:assert/strict";
import { test } from "node:test";
import { contextBand, bandText, COMMIT_RE, looksLikePreference, looksLikeResume, MILESTONE_NUDGE } from "./signals.ts";

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

test("contextBand finds the highest reached named threshold", () => {
  const bands = { save: 50, handoff: 70, compact: 85 };
  assert.equal(contextBand(40, bands), undefined);
  assert.equal(contextBand(50, bands), "save");
  assert.equal(contextBand(65, bands), "save");
  assert.equal(contextBand(70, bands), "handoff");
  assert.equal(contextBand(85, bands), "compact");
  assert.equal(contextBand(99, bands), "compact");
  assert.equal(contextBand(100, false), undefined);
});

test("bandText matches each band's exact wording", () => {
  const handoff = { handoff: true, compactTool: false };
  assert.equal(
    bandText(50.4, "save", handoff),
    "[pi-notebook] Context window 50% full. Consider saving any durable knowledge worth keeping.",
  );
  assert.equal(
    bandText(70, "handoff", handoff),
    "[pi-notebook] Context window 70% full. Consider updating the handoff if progress has changed.",
  );
  assert.equal(
    bandText(85, "compact", handoff),
    "[pi-notebook] Context window 85% full. Compaction is near. At the next clean stopping point, update the handoff.",
  );
  assert.equal(
    bandText(85, "compact", { handoff: true, compactTool: true }),
    "[pi-notebook] Context window 85% full. Compaction is near. At the next clean stopping point, update the handoff and call context_compact.",
  );
});

test("bandText falls back to save wording without a project handoff", () => {
  const noHandoff = { handoff: false, compactTool: false };
  assert.equal(
    bandText(85, "compact", noHandoff),
    "[pi-notebook] Context window 85% full. Consider saving any durable knowledge worth keeping.",
  );
});
