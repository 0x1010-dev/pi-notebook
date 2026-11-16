import assert from "node:assert/strict";
import { test } from "node:test";
import { curatePrompt, wrapPrompt } from "./prompts.ts";

test("writing guidance favors useful current knowledge without quotas or required taxonomy", () => {
  for (const prompt of [wrapPrompt(true), curatePrompt(true)]) {
    assert.match(prompt, /Saving nothing is fine/);
    assert.match(prompt, /conclusion first/);
    assert.match(prompt, /complete current account/);
    assert.match(prompt, /hypotheses/);
    assert.doesNotMatch(prompt, /kind "(decision|lesson|note)"/);
  }
  for (const prompt of [wrapPrompt(false, false), curatePrompt(false)]) {
    assert.match(prompt, /Never save this session|Do not add current-session/);
    assert.doesNotMatch(prompt, /Update the handoff|reconcile the handoff/i);
  }
  assert.match(wrapPrompt(true, false), /\/nb:init/);
});
