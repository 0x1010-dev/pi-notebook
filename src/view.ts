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
import { diagnosticText, type Entry, type Handoff, ref } from "./store.ts";
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
  if (start < offset) {
    return start;
  }
  if (end >= offset + height) {
    return Math.min(start, end - height + 1);
  }
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
  const { project, scope, handoff, entries, now = Date.now() } = input;
  const active = counts(entries);
  if (!handoff?.goal && active === 0) {
    return undefined;
  }

  let age = "";
  if (handoff?.updated) {
    const ageText = ago(handoff.updated, now);
    age =
      now - Date.parse(handoff.updated) > STALE_MS
        ? ` · ⚠ handoff ${ageText} old`
        : ` · handoff updated ${ageText === "0m" ? "just now" : `${ageText} ago`}`;
  }
  const row = (label: string, value: string) =>
    `  ${label.padEnd(8)} ${clip(value, 110)}`;
  const out = [`◆ pi-notebook · ${project.name} (${scope.mode})${age}`];

  if (!handoff?.goal) {
    out.push("  No handoff yet");
  } else {
    out.push(row("Goal", handoff.goal));
    if (handoff.status) {
      out.push(row("Status", handoff.status));
    }
    if (handoff.nextSteps[0]) {
      const more = handoff.nextSteps.length - 1;
      out.push(
        row(
          "Next",
          `› ${handoff.nextSteps[0]}${more ? ` (+${more} more)` : ""}`,
        ),
      );
    }
    handoff.blockers
      .slice(0, 2)
      .forEach((b, i) => out.push(row(i === 0 ? "Blocked" : "", `! ${b}`)));
    if (handoff.blockers.length > 2) {
      out.push(row("", `(+${handoff.blockers.length - 2} more blockers)`));
    }
    if (handoff.notes) {
      out.push(row("Notes", handoff.notes));
    }
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

function rule(theme: Theme, width: number, title: string, right = ""): string {
  const left = `${theme.fg("borderMuted", "───")} ${theme.fg("accent", "◆")} ${theme.fg("accent", theme.bold(title))} `;
  const tail = right
    ? ` ${theme.fg("dim", right)} ${theme.fg("borderMuted", "─")}`
    : "";
  const fill = Math.max(0, width - visibleWidth(left) - visibleWidth(tail));
  return truncateToWidth(
    left + theme.fg("borderMuted", "─".repeat(fill)) + tail,
    width,
  );
}

function heading(theme: Theme, label: string, meta = ""): string {
  return `  ${theme.fg("text", theme.bold(label))}${meta ? `  ${theme.fg("dim", meta)}` : ""}`;
}

/** Wrap `body` to the width, continuation lines aligned under its first character. */
function hang(prefix: string, body: string, width: number): string[] {
  const pad = visibleWidth(prefix);
  if (width - pad < 10) {
    return [prefix + body];
  }
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
    private theme: Theme,
    private tui: ViewTui,
    private onClose: () => void,
    checkStaleness?: ReturnType<typeof createStalenessChecker>,
  ) {
    this.data = {
      ...data,
      projectEntries: [...data.projectEntries].sort(newestFirst),
      globalEntries: [...data.globalEntries].sort(newestFirst),
    };
    this.checkStaleness =
      checkStaleness ??
      (data.project
        ? createStalenessChecker(data.project.root, this.abort.signal)
        : undefined);
  }

  dispose(): void {
    this.abort.abort();
  }

  private tabs(): Tab[] {
    const tabs: Tab[] = [{ id: "overview", label: "Overview" }];
    if (this.data.scope) {
      tabs.push({
        id: "memories",
        label: "Memories",
        entries: this.data.projectEntries,
      });
    }
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
      if (isList) {
        this.selected = Math.max(
          0,
          Math.min(this.selected + by, items.length - 1),
        );
      } else {
        this.offset = Math.max(0, this.offset + by);
      }
    };
    const page = isList ? 5 : this.bodyHeight() - 1;

    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c") || key === "q") {
      this.dispose();
      return this.onClose();
    }
    if (matchesKey(key, "left") || matchesKey(key, "shift+tab")) {
      this.switchTab(-1);
    } else if (matchesKey(key, "right") || matchesKey(key, "tab")) {
      this.switchTab(1);
    } else if (matchesKey(key, "up")) {
      move(-1);
    } else if (matchesKey(key, "down")) {
      move(1);
    } else if (matchesKey(key, "pageUp")) {
      move(-page);
    } else if (matchesKey(key, "pageDown")) {
      move(page);
    } else if (matchesKey(key, "home")) {
      move(-Infinity);
    } else if (matchesKey(key, "end")) {
      move(Infinity);
    } else if (
      isList &&
      (matchesKey(key, "enter") || matchesKey(key, "space"))
    ) {
      const entry = items[this.selected];
      if (entry) {
        if (!this.open.delete(entry.path)) {
          this.open.add(entry.path);
        }
        this.rows.delete(entry);
      }
    } else {
      return;
    }
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
    const { theme, data } = this;
    const tabs = this.tabs();
    this.tab = Math.min(this.tab, tabs.length - 1);
    const tab = tabs[this.tab];

    const where = data.project
      ? `${data.project.name}${data.scope ? ` · ${data.scope.mode}` : ""}`
      : "global";
    const bar = tabs
      .map((item, index) => {
        const count = item.entries ? ` ${item.entries.length}` : "";
        return index === this.tab
          ? theme.fg("accent", theme.bold(`[${item.label}${count}]`))
          : theme.fg("dim", ` ${item.label}${count} `);
      })
      .join(" ");

    let body: Body;
    if (tab.entries) {
      body = this.entryBody(tab, width);
    } else if (tab.id === "rules") {
      body = this.rulesBody(width);
    } else {
      body = this.overviewBody(width);
    }

    const height = this.bodyHeight();
    if (body.anchor) {
      this.offset = ensureVisible(
        this.offset,
        body.anchor[0],
        body.anchor[1],
        height,
      );
    }
    this.offset = clampScroll(this.offset, body.lines.length, height);
    const shown = visibleWindow(body.lines, this.offset, height);
    for (const { entry, start, end } of body.entries ?? []) {
      if (end >= this.offset && start < this.offset + height) {
        this.checkVisible(entry);
      }
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
      rule(theme, width, "Notebook", where),
      `  ${bar}`,
      "",
      ...shown,
      "",
      `  ${theme.fg("dim", pos + keys)}`,
    ].map((l) => truncateToWidth(l, width));
  }

  private entryBody(tab: Tab, width: number): Body {
    const { theme } = this;
    const items = tab.entries ?? [];
    if (items.length === 0) {
      return { lines: [`    ${theme.fg("dim", "none yet")}`] };
    }
    this.selected = Math.min(this.selected, items.length - 1);
    const lines: string[] = [];
    const entries: NonNullable<Body["entries"]> = [];
    let anchor: [number, number] | undefined;
    items.forEach((entry, i) => {
      const start = lines.length;
      let row = this.rows.get(entry);
      if (!row) {
        row = hang(
          `   ${theme.fg("accent", ref(entry).padEnd(5))} `,
          `${theme.fg("text", entry.title)}  ${theme.fg("dim", entry.date)}`,
          width,
        );
        row.push(
          ...hang("        ", theme.fg("muted", entryPreview(entry)), width),
        );
        row.push(
          ...hang("        ", theme.fg("dim", `Path: ${entry.path}`), width),
        );
        for (const note of this.notes(entry)) {
          row.push(...hang("        ", theme.fg("dim", note), width));
        }
        if (this.open.has(entry.path)) {
          row.push(...this.detail(entry, width));
        }
        this.rows.set(entry, row);
      }
      lines.push(...row);
      if (i === this.selected) {
        lines[start] = ` ${theme.fg("accent", "▸")}${lines[start].slice(2)}`;
      }
      entries.push({ entry: entry, start, end: lines.length - 1 });
      if (i === this.selected) {
        anchor = [start, lines.length - 1];
      }
    });
    return { lines, anchor, entries };
  }

  private notes(entry: Entry): string[] {
    const lines = metadataLines(entry);
    if (entry.commit && this.checkStaleness) {
      const warning = this.warnings.has(entry)
        ? this.warnings.get(entry)
        : "Checking code baseline…";
      if (warning) {
        lines.push(warning);
      }
    }
    return lines;
  }

  private checkVisible(entry: Entry): void {
    const check = this.checkStaleness;
    const commit = entry.commit;
    if (
      !check ||
      !commit ||
      this.warnings.has(entry) ||
      this.checking.has(entry) ||
      this.abort.signal.aborted
    ) {
      return;
    }
    this.checking.add(entry);
    // Start work after rendering, and only for entries that reached the viewport.
    queueMicrotask(async () => {
      if (this.abort.signal.aborted) {
        return;
      }
      const warning = await check(commit, entry.files);
      if (this.abort.signal.aborted) {
        return;
      }
      this.warnings.set(entry, warning);
      this.checking.delete(entry);
      this.rows.delete(entry);
      this.tui.requestRender();
    });
  }

  private detail(entry: Entry, width: number): string[] {
    const { theme } = this;
    const pad = "        ";
    const out: string[] = [];
    for (const para of (entry.body.trim() || "(no details)").split("\n")) {
      out.push(
        ...(para.trim() ? hang(pad, theme.fg("muted", para), width) : [""]),
      );
    }
    out.push("");
    return out;
  }

  private rulesBody(width: number): Body {
    const { theme, data } = this;
    const lines: string[] = [];
    const section = (label: string, rules: string[]) => {
      lines.push(heading(theme, label, `${rules.length}`));
      if (rules.length === 0) {
        lines.push(`    ${theme.fg("dim", "none yet")}`);
      }
      for (const r of rules) {
        lines.push(
          ...hang(`    ${theme.fg("dim", "•")} `, theme.fg("text", r), width),
        );
      }
      lines.push("");
    };
    if (data.scope) {
      section("Conventions (this project)", data.conventions);
    }
    section("Preferences (everywhere)", data.preferences);
    return { lines };
  }

  private overviewBody(width: number): Body {
    const { theme, data } = this;
    const lines: string[] = [];
    const entries: NonNullable<Body["entries"]> = [];
    const diagnostics = diagnosticText(data.diagnostics ?? []);
    if (diagnostics) {
      lines.push(...hang("  ", theme.fg("warning", diagnostics), width), "");
    }
    if (data.project && !data.scope) {
      lines.push(
        `  ${theme.fg("dim", "No notebook for this project. Run")} ${theme.fg("accent", "/nb:init")} ${theme.fg("dim", "or save something.")}`,
        "",
      );
    }

    if (data.scope) {
      const handoff = data.handoff;
      lines.push(
        heading(
          theme,
          "Handoff",
          handoff?.updated ? `updated ${ago(handoff.updated)} ago` : "",
        ),
      );
      if (!handoff) {
        lines.push(`    ${theme.fg("dim", "none yet")}`);
      } else {
        const field = (label: string, value: string) =>
          hang(
            `    ${theme.fg("muted", label.padEnd(8))}`,
            theme.fg("text", value),
            width,
          );
        if (handoff.goal) {
          lines.push(...field("goal", handoff.goal));
        }
        if (handoff.status) {
          lines.push(...field("status", handoff.status));
        }
        handoff.nextSteps.forEach((s, i) =>
          lines.push(
            ...hang(
              `    ${theme.fg("muted", (i === 0 ? "next" : "").padEnd(8))}${theme.fg("accent", "›")} `,
              theme.fg("text", s),
              width,
            ),
          ),
        );
        handoff.blockers.forEach((s, i) =>
          lines.push(
            ...hang(
              `    ${theme.fg("muted", (i === 0 ? "blocked" : "").padEnd(8))}${theme.fg("warning", "!")} `,
              theme.fg("text", s),
              width,
            ),
          ),
        );
        if (handoff.notes) {
          lines.push(...field("notes", handoff.notes));
        }
      }
      lines.push("");

      const active = data.projectEntries;
      lines.push(heading(theme, "Memories", `${active.length} active`));
      this.previewEntries(lines, active.slice(0, 3), width, entries);
      if (active.length > 3) {
        lines.push(
          `    ${theme.fg("dim", `… ${active.length - 3} more in Memories`)}`,
        );
      }
      if (active.length === 0) {
        lines.push(`    ${theme.fg("dim", "none yet")}`);
      }
      lines.push("");
    }

    const global = data.globalEntries;
    lines.push(heading(theme, "Global", `${global.length} active`));
    this.previewEntries(lines, global.slice(0, 2), width, entries);
    if (global.length > 2) {
      lines.push(
        `    ${theme.fg("dim", `… ${global.length - 2} more in Global`)}`,
      );
    }
    if (global.length === 0) {
      lines.push(`    ${theme.fg("dim", "none yet")}`);
    }
    lines.push(
      "",
      `  ${theme.fg("dim", "injected")} ${theme.fg("muted", `≈${data.injectedTokens} tokens/turn`)}`,
    );
    return { lines, entries };
  }

  private previewEntries(
    lines: string[],
    entries: Entry[],
    width: number,
    ranges: NonNullable<Body["entries"]>,
  ): void {
    const { theme } = this;
    for (const entry of entries) {
      const start = lines.length;
      lines.push(
        ...hang(
          `    ${theme.fg("accent", ref(entry).padEnd(5))} `,
          theme.fg("text", entry.title),
          width,
        ),
        ...hang("        ", theme.fg("muted", entryPreview(entry)), width),
      );
      for (const note of this.notes(entry)) {
        lines.push(...hang("        ", theme.fg("dim", note), width));
      }
      ranges.push({ entry: entry, start, end: lines.length - 1 });
    }
  }
}
