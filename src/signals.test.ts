import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMIT_RE,
  detectNudge,
  freshSignals,
  looksLikePreference,
  looksLikeResume,
  type NudgeKind,
  type TurnFacts,
} from "./signals.ts";

test("resume detection", () => {
  assert.ok(looksLikeResume("Where did we end up yesterday?"));
  assert.ok(looksLikeResume("What's the plan for today?"));
  assert.ok(looksLikeResume("let's continue"));
  assert.ok(looksLikeResume("catch me up"));
  assert.ok(!looksLikeResume("fix the failing test"));
  assert.ok(!looksLikeResume("run git status"));
});

test("preference detection", () => {
  assert.ok(looksLikePreference("From now on use pnpm"));
  assert.ok(looksLikePreference("I prefer tabs"));
  assert.ok(looksLikePreference("never use em-dashes"));
  assert.ok(!looksLikePreference("fix the failing test"));
  assert.ok(!looksLikePreference("don't break the build"));
});

test("commit detection", () => {
  assert.ok(COMMIT_RE.test('git commit -m "x"'));
  assert.ok(COMMIT_RE.test("git -C repo commit -am wip"));
  assert.ok(!COMMIT_RE.test("git status && echo commit"));
});

test("nudge priority, dedupe and cooldown", () => {
  const policy = {
    checkpointTurns: 30,
    handoffAfterTurns: 6,
    cooldownTurns: 8,
  };
  const base: TurnFacts = {
    ...freshSignals(),
    contextHigh: false,
    handoffMissing: false,
    turnsSinceSave: 0,
  };
  const none = new Set<NudgeKind>();
  const at = (f: Partial<TurnFacts>, fired = none, since = 99) =>
    detectNudge({ ...base, ...f }, policy, fired, since);

  assert.equal(at({}), undefined);
  assert.equal(at({ recovered: true }), "lesson");
  assert.equal(at({ recovered: true, committed: true }), "milestone");
  assert.equal(at({ handoffMissing: true, turnsSinceSave: 5 }), undefined);
  assert.equal(at({ handoffMissing: true, turnsSinceSave: 6 }), "handoff");
  assert.equal(at({ turnsSinceSave: 30 }), "checkpoint");
  assert.equal(at({ contextHigh: true, committed: true }), "context");

  assert.equal(at({ committed: true }, none, 3), undefined);
  assert.equal(at({ contextHigh: true }, none, 0), "context");
  assert.equal(at({ committed: true }, new Set(["milestone"])), undefined);
  assert.equal(
    at({ committed: true, recovered: true }, new Set(["milestone"])),
    "lesson",
  );
});
