import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Entry, Handoff } from "./store.ts";
import { counts, statusLine } from "./ui.ts";
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
      entries: [],
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

test("large lists check freshness only after rendering visible entries and reuse formatted rows", async () => {
  let formatting = 0;
  let renders = 0;
  const checked: string[] = [];
  const theme = {
    fg: (_color: string, value: string) => { formatting++; return value; },
    bold: (value: string) => value,
  } as Theme;
  const data = {
    ...base, handoff: undefined, globalEntries: [],
    projectEntries: Array.from({ length: 1000 }, (_, i) =>
      entry(i + 1, "project", { commit: `baseline-${i + 1}` })),
  };
  const originalOrder = data.projectEntries.map((e) => e.id);
  const view = new NotebookView(data, theme, {
    terminal: { rows: 24 }, requestRender() { renders++; },
  }, () => {}, async (commit) => {
    checked.push(commit);
    return `Saved at ${commit}; check the code.`;
  });
  view.handleInput("\x1b[C");
  renders = 0;
  const first = view.render(120).join("\n");
  assert.match(first, /Checking code baseline/);
  assert.equal(checked.length, 0, "render must not execute Git checks");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(checked.length > 0 && checked.length < 10, "off-screen entries must not trigger Git");
  assert.equal(renders, checked.length);
  assert.match(view.render(120).join("\n"), /Saved at baseline-1000/);
  const before = formatting;
  view.render(120);
  assert.ok(formatting - before < 30, "unchanged redraw must reuse formatted rows");
  const checkedBefore = checked.length;
  view.handleInput("\x1b[B");
  view.render(120);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(new Set(checked).size, checked.length, "each entry is checked once per view");
  assert.ok(checked.length >= checkedBefore);
  assert.deepEqual(data.projectEntries.map((e) => e.id), originalOrder, "sorting must not mutate input");
  view.invalidate();
  const invalidated = formatting;
  view.render(80);
  assert.ok(formatting - invalidated > 1000, "resize and theme invalidation refresh rows");
  view.handleInput("\x1b[F");
  assert.match(view.render(80).join("\n"), /▸ M1\s/);
  view.handleInput("\x1b[H");
  assert.match(view.render(80).join("\n"), /▸ M1000\s/);
  view.dispose();
});

test("cached rows update when expanding and collapsing details", () => {
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
  const view = new NotebookView({
    ...base,
    projectEntries: [entry(1, "project", { body: "Conclusion.\n\nAdditional details only shown when expanded." })],
  }, theme, { terminal: { rows: 24 }, requestRender() {} }, () => {});
  view.handleInput("\x1b[C");
  assert.doesNotMatch(view.render(120).join("\n"), /Additional details/);
  view.handleInput("\r");
  assert.match(view.render(120).join("\n"), /Additional details/);
  view.handleInput("\r");
  assert.doesNotMatch(view.render(120).join("\n"), /Additional details/);
  view.dispose();
});

test("malformed memory diagnostics remain visible in the browser and status line", () => {
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
  const data = {
    ...base,
    diagnostics: [{ path: "/r/.pi/notebook/memories/0042-broken.md", reason: "Invalid tags: expected a list." }],
  };
  const view = new NotebookView(data, theme, { terminal: { rows: 24 }, requestRender() {} }, () => {});
  const rendered = view.render(120).join("\n");
  assert.match(rendered, /files need repair/);
  assert.match(rendered, /0042-broken/);
  assert.match(rendered, /Invalid tags/);
  assert.match(statusLine(theme, data), /1 files need repair/);
  view.dispose();
});

test("closing the view cancels queued freshness work and late results cannot redraw", async () => {
  let calls = 0;
  let renders = 0;
  let finish: ((warning: string) => void) | undefined;
  const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as Theme;
  const data = { ...base, handoff: undefined, projectEntries: [entry(1, "project", { commit: "abc" })] };
  const view = new NotebookView(data, theme, {
    terminal: { rows: 24 }, requestRender() { renders++; },
  }, () => {}, () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  });
  view.render(120);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  view.dispose();
  finish!("Late warning");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(renders, 0);

  const queued = new NotebookView(data, theme, {
    terminal: { rows: 24 }, requestRender() { renders++; },
  }, () => {}, async () => { calls++; return undefined; });
  queued.render(120);
  queued.handleInput("q");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
});
