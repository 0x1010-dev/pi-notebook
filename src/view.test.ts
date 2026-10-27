import assert from "node:assert/strict";
import { test } from "node:test";
import type { Entry, Handoff } from "./store.ts";
import {
  clampScroll,
  ensureVisible,
  startupSummary,
  visibleWindow,
} from "./view.ts";

test("clampScroll keeps the offset inside the content", () => {
  assert.equal(clampScroll(5, 20, 10), 5);
  assert.equal(clampScroll(50, 20, 10), 10);
  assert.equal(clampScroll(-3, 20, 10), 0);
  assert.equal(clampScroll(4, 6, 10), 0);
  assert.equal(clampScroll(Infinity, 20, 10), 10);
});

test("visibleWindow returns the lines in view", () => {
  const lines = ["a", "b", "c", "d", "e"];
  assert.deepEqual(visibleWindow(lines, 1, 2), ["b", "c"]);
  assert.deepEqual(visibleWindow(lines, 9, 2), ["d", "e"]);
  assert.deepEqual(visibleWindow(lines, 0, 10), lines);
});

test("ensureVisible scrolls the least needed", () => {
  assert.equal(ensureVisible(10, 12, 13, 5), 10);
  assert.equal(ensureVisible(10, 4, 5, 5), 4);
  assert.equal(ensureVisible(0, 8, 9, 5), 5);
  assert.equal(ensureVisible(0, 8, 30, 5), 8);
});

const entry = (kind: Entry["kind"], id: number): Entry => ({
  scope: "project",
  kind,
  id,
  title: `t${id}`,
  status: "active",
  date: "2026-01-01",
  body: "",
  path: `/x/${kind}${id}`,
});

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  goal: "Ship auth",
  status: "Tests failing",
  nextSteps: ["Fix cookie test", "Docs"],
  blockers: ["API key", "Review", "Legal"],
  notes: "",
  updated: "2026-10-27T12:00:00.000Z",
  ...over,
});

const base = {
  project: { root: "/r", name: "app" },
  scope: { kind: "project" as const, dir: "/r/.pi", agentsFile: "/r/AGENTS.md", mode: "repo" as const },
  entries: [entry("decision", 1), entry("lesson", 1), entry("lesson", 2), entry("note", 1)],
  now: Date.parse("2026-10-27T14:00:00.000Z"),
};

test("startup summary shows handoff and counts", () => {
  const s = startupSummary({ ...base, handoff: handoff() })!.split("\n");
  assert.equal(s[0], "◆ pi-notebook · app (repo) · handoff updated 2h ago");
  assert.ok(s.some((l) => /Goal\s+Ship auth/.test(l)));
  assert.ok(s.some((l) => l.includes("Fix cookie test (+1 more)")));
  assert.ok(s.some((l) => l.includes("! API key")));
  assert.ok(s.some((l) => l.includes("(+1 more blockers)")));
  assert.ok(s.at(-1)!.includes("1 decisions · 2 lessons · 1 notes · /nb to browse"));
});

test("startup summary warns about a stale handoff", () => {
  const s = startupSummary({
    ...base,
    handoff: handoff({ updated: "2026-10-20T12:00:00.000Z" }),
  })!;
  assert.ok(s.split("\n")[0].includes("⚠ handoff 7d old"));
});

test("startup summary without a handoff or entries is skipped", () => {
  assert.equal(startupSummary({ ...base, entries: [] }), undefined);
  assert.ok(startupSummary({ ...base })!.includes("No handoff yet"));
});
