import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Entry, Handoff } from "./store.ts";
import { counts } from "./ui.ts";
import {
  clampScroll,
  ensureVisible,
  NotebookView,
  startupSummary,
  visibleWindow,
  type ViewData,
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

const entry = (
  id: number,
  scope: Entry["scope"] = "project",
  over: Partial<Entry> = {},
): Entry => ({
  scope,
  id,
  title: `Memory ${id}`,
  status: "active",
  date: "2026-01-01",
  body: `Conclusion ${id}. Supporting details follow.`,
  path: `/x/memory-${id}.md`,
  tags: ["testing", "design"],
  ...over,
});

const handoff = (over: Partial<Handoff> = {}): Handoff => ({
  goal: "Ship auth",
  status: "Tests failing",
  nextSteps: ["Fix cookie test", "Docs"],
  blockers: ["API key", "Review", "Legal"],
  notes: "Coordinate the release",
  updated: "2026-10-27T12:00:00.000Z",
  ...over,
});

const base: ViewData = {
  project: { root: "/r", name: "app" },
  scope: {
    kind: "project",
    dir: "/r/.pi",
    agentsFile: "/r/AGENTS.md",
    mode: "repo",
  },
  projectEntries: [
    entry(1, "project", { files: ["src/auth.ts"] }),
    entry(2, "project", { status: "retired", retiredReason: "Replaced" }),
  ],
  globalEntries: [entry(3, "global")],
  handoff: handoff(),
  preferences: ["Prefer concise diffs"],
  conventions: ["Use existing tests"],
  injectedTokens: 42,
};

test("counts returns the number of active entries", () => {
  assert.equal(counts(base.projectEntries), 1);
  assert.equal(counts([]), 0);
});

test("startup summary shows handoff and active counts", () => {
  const s = startupSummary({
    project: base.project!,
    scope: base.scope!,
    handoff: handoff(),
    entries: base.projectEntries,
    now: Date.parse("2026-10-27T14:00:00.000Z"),
  })!.split("\n");
  assert.equal(s[0], "◆ pi-notebook · app (repo) · handoff updated 2h ago");
  assert.ok(s.some((l) => /Goal\s+Ship auth/.test(l)));
  assert.ok(s.some((l) => l.includes("Fix cookie test (+1 more)")));
  assert.ok(s.some((l) => l.includes("! API key")));
  assert.ok(s.some((l) => l.includes("(+1 more blockers)")));
  assert.ok(s.some((l) => l.includes("Coordinate the release")));
  assert.ok(s.at(-1)!.includes("1 active memories · /nb to browse"));
});

test("startup summary warns about a stale handoff", () => {
  const s = startupSummary({
    project: base.project!,
    scope: base.scope!,
    handoff: handoff({ updated: "2026-10-20T12:00:00.000Z" }),
    entries: base.projectEntries,
    now: Date.parse("2026-10-27T12:00:00.000Z"),
  })!;
  assert.ok(s.split("\n")[0].includes("⚠ handoff 7d old"));
});

test("startup summary without a handoff or active entries is skipped", () => {
  assert.equal(
    startupSummary({
      project: base.project!,
      scope: base.scope!,
      entries: base.projectEntries.map((e) => ({ ...e, status: "retired" })),
    }),
    undefined,
  );
  assert.ok(
    startupSummary({
      project: base.project!,
      scope: base.scope!,
      entries: base.projectEntries,
    })!.includes("No handoff yet"),
  );
});

test("notebook renders simplified tabs and entry context", () => {
  const theme = {
    fg: (_color: string, value: string) => value,
    bold: (value: string) => value,
  } as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} };
  const view = new NotebookView(base, theme, tui, () => {});

  const overview = view.render(120).join("\n");
  assert.ok(overview.includes("Overview"));
  assert.ok(overview.includes("Memories"));
  assert.ok(overview.includes("Global"));
  assert.ok(overview.includes("Rules"));
  assert.ok(overview.includes("Coordinate the release"));
  assert.ok(overview.includes("Conclusion 1."));

  view.handleInput("\x1b[C");
  const memories = view.render(120).join("\n");
  assert.ok(memories.includes("[Memories 1]"));
  assert.ok(memories.includes("Memory 1"));
  assert.ok(memories.includes("Conclusion 1."));
  assert.ok(memories.includes("#testing #design"));
  assert.ok(memories.includes("/x/memory-1.md"));
  assert.ok(memories.includes("Files: src/auth.ts"));
});
