import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "./config.ts";

const settingsDir = mkdtempSync(join(tmpdir(), "nb-config-"));
process.env.PI_CODING_AGENT_DIR = settingsDir;
after(() => rmSync(settingsDir, { recursive: true, force: true }));

function loadBands(contextBands: unknown) {
  writeFileSync(join(settingsDir, "settings.json"), JSON.stringify({ notebook: { contextBands } }));
  return loadConfig().contextBands;
}

test("context bands load named ascending percentages", () => {
  const bands = { save: 25.5, handoff: 60, compact: 100 };
  assert.deepEqual(loadBands(bands), bands);
});

test("false disables context reminders", () => {
  assert.equal(loadBands(false), false);
});

test("invalid context bands retain defaults", () => {
  for (const bands of [
    null, true, [], [40, 55, 70], {},
    { save: 40, handoff: 55 },
    { save: 0, handoff: 55, compact: 70 },
    { save: -1, handoff: 55, compact: 70 },
    { save: "40", handoff: 55, compact: 70 },
    { save: 40, handoff: 40, compact: 70 },
    { save: 55, handoff: 40, compact: 70 },
    { save: 40, handoff: 70, compact: 55 },
    { save: 40, handoff: 55, compact: 101 },
  ]) assert.deepEqual(loadBands(bands), DEFAULT_CONFIG.contextBands);
});