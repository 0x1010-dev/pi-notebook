import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { clip, entryPreview, metadataLines } from "./format.ts";
import { createStalenessChecker } from "./git.ts";
import type { Project, Scope } from "./paths.ts";
import { type Entry, type Handoff, ref } from "./store.ts";
import { ago, counts, STALE_MS, type StatusInfo } from "./ui.ts";

/** Scroll offset kept inside the content. */
export function clampScroll(
  offset: number,
  total: number,
  height: number,
): number {
  return Math.max(0, Math.min(offset, total - height));
}

export function visibleWindow<T>(
  lines: T[],
  offset: number,
  height: number,
): T[] {
  const start = clampScroll(offset, lines.length, height);
  return lines.slice(start, start + height);
}

/** Smallest scroll change that shows lines start..end; the start wins when they do not fit. */
export function ensureVisible(
  offset: number,
  start: number,
  end: number,
  height: number,
): number {
  if (start < offset) return start;
  if (end >= offset + height) return Math.min(start, end - height + 1);
  return offset;
}

export interface StartupInput {
  project: Project;
  scope: Scope;
  handoff?: Handoff;
  entries: Entry[];
  now?: number;
}

/** Notice shown when a session starts in a project with a notebook. */
export function startupSummary(input: StartupInput): string | undefined {
  const { project, scope, handoff: h, entries, now = Date.now() } = input;
  const active = counts(entries);
  if (!h?.goal && active === 0) return undefined;

  let age = "";
  if (h?.updated) {
    const a = ago(h.updated, now);
    age =
      now - Date.parse(h.updated) > STALE_MS
        ? ` · ⚠ handoff ${a} old`
        : ` · handoff updated ${a === "0m" ? "just now" : `${a} ago`}`;
  }
  const row = (label: string, value: string) =>
    `  ${label.padEnd(8)} ${clip(value, 110)}`;
  const out = [`◆ pi-notebook · ${project.name} (${scope.mode})${age}`];

  if (!h?.goal) {
    out.push("  No handoff yet");
  } else {
    out.push(row("Goal", h.goal));
    if (h.status) out.push(row("Status", h.status));
    if (h.nextSteps[0]) {
      const more = h.nextSteps.length - 1;
      out.push(row("Next", `› ${h.nextSteps[0]}${more ? ` (+${more} more)` : ""}`));
    }
    h.blockers
      .slice(0, 2)
      .forEach((b, i) => out.push(row(i === 0 ? "Blocked" : "", `! ${b}`)));
    if (h.blockers.length > 2)
      out.push(row("", `(+${h.blockers.length - 2} more blockers)`));
    if (h.notes) out.push(row("Notes", h.notes));
  }
  out.push(row("Notebook", `${active} active memories · /nb to browse`));
  return out.join("\n");
}

export interface ViewData extends StatusInfo {
  preferences: string[];
  conventions: string[];
  injectedTokens: number;
}

/** The parts of the TUI the view needs. */
export interface ViewTui {
  terminal: { rows: number };
  requestRender(): void;
}

interface Tab {
  id: string;
  label: string;
  entries?: Entry[];
}

interface Body {
  lines: string[];
  entries?: { entry: Entry; start: number; end: number }[];
  /** First and last line of the selected entry. */
  anchor?: [number, number];
}

function rule(th: Theme, width: number, title: string, right = ""): string {
  const left = `${th.fg("borderMuted", "───")} ${th.fg("accent", "◆")} ${th.fg("accent", th.bold(title))} `;
  const tail = right
    ? ` ${th.fg("dim", right)} ${th.fg("borderMuted", "─")}`
    : "";
  const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(tail));
  return truncateToWidth(
    left + th.fg("borderMuted", "─".repeat(fill)) + tail,
    width,
  );
}

function heading(th: Theme, label: string, meta = ""): string {
  return `  ${th.fg("text", th.bold(label))}${meta ? `  ${th.fg("dim", meta)}` : ""}`;
}

/** Wrap `body` to the width, continuation lines aligned under its first character. */
function hang(prefix: string, body: string, width: number): string[] {
  const pad = visibleWidth(prefix);
  if (width - pad < 10) return [prefix + body];
  return wrapTextWithAnsi(body, width - pad).map(
    (l, i) => (i ? " ".repeat(pad) : prefix) + l,
  );
}

const newestFirst = (a: Entry, b: Entry) =>
  b.date.localeCompare(a.date) || b.id - a.id;

export class NotebookView {
  private tab = 0;
  private offset = 0;
  private selected = 0;
  private open = new Set<string>();
  private rowWidth = 0;
  private rows = new Map<Entry, string[]>();
  private warnings = new Map<Entry, string | undefined>();
  private checking = new Set<Entry>();
  private abort = new AbortController();
  private checkStaleness: ReturnType<typeof createStalenessChecker> | undefined;

  constructor(
    private data: ViewData,
    private th: Theme,
    private tui: ViewTui,
    private onClose: () => void,
    checkStaleness?: ReturnType<typeof createStalenessChecker>,
  ) {
    this.data = {
      ...data,
      projectEntries: [...data.projectEntries].sort(newestFirst),
      globalEntries: [...data.globalEntries].sort(newestFirst),
    };
    this.checkStaleness = checkStaleness ?? (data.project
      ? createStalenessChecker(data.project.root, this.abort.signal)
      : undefined);
  }

  dispose(): void {
    this.abort.abort();
  }

  private tabs(): Tab[] {
    const tabs: Tab[] = [{ id: "overview", label: "Overview" }];
    if (this.data.scope)
      tabs.push({
        id: "memories",
        label: "Memories",
        entries: this.data.projectEntries,
      });
    tabs.push(
      { id: "global", label: "Global", entries: this.data.globalEntries },
      { id: "rules", label: "Rules" },
    );
    return tabs;
  }

  private bodyHeight(): number {
    return Math.max(5, this.tui.terminal.rows - 8);
  }

  private switchTab(by: number): void {
    const n = this.tabs().length;
    this.tab = (this.tab + by + n) % n;
    this.offset = 0;
    this.selected = 0;
  }

  handleInput(key: string): void {
    const tab = this.tabs()[this.tab];
    const isList = !!tab.entries;
    const items = tab.entries ?? [];
    const move = (by: number) => {
      if (isList)
        this.selected = Math.max(
          0,
          Math.min(this.selected + by, items.length - 1),
        );
      else this.offset = Math.max(0, this.offset + by);
    };
    const page = isList ? 5 : this.bodyHeight() - 1;

    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c") || key === "q") {
      this.dispose();
      return this.onClose();
    }
    if (matchesKey(key, "left") || matchesKey(key, "shift+tab"))
      this.switchTab(-1);
    else if (matchesKey(key, "right") || matchesKey(key, "tab"))
      this.switchTab(1);
    else if (matchesKey(key, "up")) move(-1);
    else if (matchesKey(key, "down")) move(1);
    else if (matchesKey(key, "pageUp")) move(-page);
    else if (matchesKey(key, "pageDown")) move(page);
    else if (matchesKey(key, "home")) move(-Infinity);
    else if (matchesKey(key, "end")) move(Infinity);
    else if (isList && (matchesKey(key, "enter") || matchesKey(key, "space"))) {
      const e = items[this.selected];
      if (e) {
        if (!this.open.delete(e.path)) this.open.add(e.path);
        this.rows.delete(e);
      }
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {
    this.rows.clear();
  }

  render(width: number): string[] {
    if (width !== this.rowWidth) {
      this.rowWidth = width;
      this.rows.clear();
    }
    const { th, data } = this;
    const tabs = this.tabs();
    this.tab = Math.min(this.tab, tabs.length - 1);
    const tab = tabs[this.tab];

    const where = data.project
      ? `${data.project.name}${data.scope ? ` · ${data.scope.mode}` : ""}`
      : "global";
    const bar = tabs
      .map((t, i) => {
        const n = t.entries
          ? ` ${t.entries.length}`
          : "";
        return i === this.tab
          ? th.fg("accent", th.bold(`[${t.label}${n}]`))
          : th.fg("dim", ` ${t.label}${n} `);
      })
      .join(" ");

    const body = tab.entries
      ? this.entryBody(tab, width)
      : tab.id === "rules"
        ? this.rulesBody(width)
        : this.overviewBody(width);

    const height = this.bodyHeight();
    if (body.anchor)
      this.offset = ensureVisible(this.offset, body.anchor[0], body.anchor[1], height);
    this.offset = clampScroll(this.offset, body.lines.length, height);
    const shown = visibleWindow(body.lines, this.offset, height);
    for (const { entry, start, end } of body.entries ?? []) {
      if (end >= this.offset && start < this.offset + height)
        this.checkVisible(entry);
    }
    const pos =
      body.lines.length > height
        ? `${this.offset + 1}–${this.offset + shown.length} of ${body.lines.length} lines · `
        : "";
    const keys = tab.entries
      ? "↑↓ select · enter open · ←→ tab · esc close"
      : "↑↓ scroll · ←→ tab · esc close";

    return [
      "",
      rule(th, width, "Notebook", where),
      `  ${bar}`,
      "",
      ...shown,
      "",
      `  ${th.fg("dim", pos + keys)}`,
    ].map((l) => truncateToWidth(l, width));
  }

  private entryBody(tab: Tab, width: number): Body {
    const { th } = this;
    const items = tab.entries ?? [];
    if (items.length === 0) {
      return { lines: [`    ${th.fg("dim", "none yet")}`] };
    }
    this.selected = Math.min(this.selected, items.length - 1);
    const lines: string[] = [];
    const entries: NonNullable<Body["entries"]> = [];
    let anchor: [number, number] | undefined;
    items.forEach((e, i) => {
      const start = lines.length;
      let row = this.rows.get(e);
      if (!row) {
        row = hang(
          `   ${th.fg("accent", ref(e).padEnd(5))} `,
          `${th.fg("text", e.title)}  ${th.fg("dim", e.date)}`,
          width,
        );
        row.push(...hang("        ", th.fg("muted", entryPreview(e)), width));
        row.push(...hang("        ", th.fg("dim", `Path: ${e.path}`), width));
        for (const note of this.notes(e))
          row.push(...hang("        ", th.fg("dim", note), width));
        if (this.open.has(e.path)) row.push(...this.detail(e, width));
        this.rows.set(e, row);
      }
      lines.push(...row);
      if (i === this.selected)
        lines[start] = ` ${th.fg("accent", "▸")}${lines[start].slice(2)}`;
      entries.push({ entry: e, start, end: lines.length - 1 });
      if (i === this.selected) anchor = [start, lines.length - 1];
    });
    return { lines, anchor, entries };
  }

  private notes(e: Entry): string[] {
    const lines = metadataLines(e);
    if (e.commit && this.checkStaleness) {
      const warning = this.warnings.has(e)
        ? this.warnings.get(e)
        : "Checking code baseline…";
      if (warning) lines.push(warning);
    }
    return lines;
  }

  private checkVisible(e: Entry): void {
    const check = this.checkStaleness;
    const commit = e.commit;
    if (!check || !commit || this.warnings.has(e) || this.checking.has(e) || this.abort.signal.aborted)
      return;
    this.checking.add(e);
    // Start work after rendering, and only for entries that reached the viewport.
    queueMicrotask(async () => {
      if (this.abort.signal.aborted) return;
      const warning = await check(commit, e.files);
      if (this.abort.signal.aborted) return;
      this.warnings.set(e, warning);
      this.checking.delete(e);
      this.rows.delete(e);
      this.tui.requestRender();
    });
  }

  private detail(e: Entry, width: number): string[] {
    const { th } = this;
    const pad = "        ";
    const out: string[] = [];
    for (const para of (e.body.trim() || "(no details)").split("\n"))
      out.push(...(para.trim() ? hang(pad, th.fg("muted", para), width) : [""]));
    out.push("");
    return out;
  }

  private rulesBody(width: number): Body {
    const { th, data } = this;
    const lines: string[] = [];
    const section = (label: string, rules: string[]) => {
      lines.push(heading(th, label, `${rules.length}`));
      if (rules.length === 0) lines.push(`    ${th.fg("dim", "none yet")}`);
      for (const r of rules)
        lines.push(...hang(`    ${th.fg("dim", "•")} `, th.fg("text", r), width));
      lines.push("");
    };
    if (data.scope) section("Conventions (this project)", data.conventions);
    section("Preferences (everywhere)", data.preferences);
    return { lines };
  }

  private overviewBody(width: number): Body {
    const { th, data } = this;
    const lines: string[] = [];
    const entries: NonNullable<Body["entries"]> = [];
    if (data.project && !data.scope)
      lines.push(
        `  ${th.fg("dim", "No notebook for this project. Run")} ${th.fg("accent", "/nb:init")} ${th.fg("dim", "or save something.")}`,
        "",
      );

    if (data.scope) {
      const h = data.handoff;
      lines.push(
        heading(th, "Handoff", h?.updated ? `updated ${ago(h.updated)} ago` : ""),
      );
      if (!h) {
        lines.push(`    ${th.fg("dim", "none yet")}`);
      } else {
        const field = (label: string, value: string) =>
          hang(`    ${th.fg("muted", label.padEnd(8))}`, th.fg("text", value), width);
        if (h.goal) lines.push(...field("goal", h.goal));
        if (h.status) lines.push(...field("status", h.status));
        h.nextSteps.forEach((s, i) =>
          lines.push(
            ...hang(
              `    ${th.fg("muted", (i === 0 ? "next" : "").padEnd(8))}${th.fg("accent", "›")} `,
              th.fg("text", s),
              width,
            ),
          ),
        );
        h.blockers.forEach((s, i) =>
          lines.push(
            ...hang(
              `    ${th.fg("muted", (i === 0 ? "blocked" : "").padEnd(8))}${th.fg("warning", "!")} `,
              th.fg("text", s),
              width,
            ),
          ),
        );
        if (h.notes) lines.push(...field("notes", h.notes));
      }
      lines.push("");

      const active = data.projectEntries;
      lines.push(heading(th, "Memories", `${active.length} active`));
      this.previewEntries(lines, active.slice(0, 3), width, entries);
      if (active.length > 3)
        lines.push(`    ${th.fg("dim", `… ${active.length - 3} more in Memories`)}`);
      if (active.length === 0) lines.push(`    ${th.fg("dim", "none yet")}`);
      lines.push("");
    }

    const global = data.globalEntries;
    lines.push(heading(th, "Global", `${global.length} active`));
    this.previewEntries(lines, global.slice(0, 2), width, entries);
    if (global.length > 2)
      lines.push(`    ${th.fg("dim", `… ${global.length - 2} more in Global`)}`);
    if (global.length === 0) lines.push(`    ${th.fg("dim", "none yet")}`);
    lines.push(
      "",
      `  ${th.fg("dim", "injected")} ${th.fg("muted", `≈${data.injectedTokens} tokens/turn`)}`,
    );
    return { lines, entries };
  }

  private previewEntries(
    lines: string[], entries: Entry[], width: number,
    ranges: NonNullable<Body["entries"]>,
  ): void {
    const { th } = this;
    for (const e of entries) {
      const start = lines.length;
      lines.push(
        ...hang(
          `    ${th.fg("accent", ref(e).padEnd(5))} `,
          th.fg("text", e.title),
          width,
        ),
        ...hang("        ", th.fg("muted", entryPreview(e)), width),
      );
      for (const note of this.notes(e))
        lines.push(...hang("        ", th.fg("dim", note), width));
      ranges.push({ entry: e, start, end: lines.length - 1 });
    }
  }
}
