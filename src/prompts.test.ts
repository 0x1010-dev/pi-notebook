import assert from "node:assert/strict";
import { test } from "node:test";
import { curatePrompt, wrapPrompt } from "./prompts.ts";

test("writing guidance favors useful current knowledge without quotas or required taxonomy", () => {
  for (const prompt of [wrapPrompt(true), curatePrompt()]) {
    assert.match(prompt, /Saving nothing is fine/);
    assert.match(prompt, /conclusion first/);
    assert.match(prompt, /complete current account/);
    assert.match(prompt, /hypotheses/);
    assert.doesNotMatch(prompt, /kind "(decision|lesson|note)"/);
  }
  assert.doesNotMatch(wrapPrompt(false), /Update the handoff/);
  assert.match(curatePrompt(), /Resolve contradictions/);
});
