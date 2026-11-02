import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_RE, looksLikePreference, looksLikeResume, nudgeText } from "./signals.ts";

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
  assert.match(nudgeText("context"), /Saving no new memories is fine/);
  assert.match(nudgeText("milestone"), /Otherwise ignore/);
});
