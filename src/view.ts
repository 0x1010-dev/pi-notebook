import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { clip } from "./format.ts";
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
  const c = counts(entries);
  if (!h?.goal && c.d + c.l + c.n === 0) return undefined;

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
  }
  out.push(
    row(
      "Notebook",
      `${c.d} decisions · ${c.l} lessons · ${c.n} notes · /nb to browse`,
    ),
  );
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
  /** Tabs that list entries; others are free-form. */
  entries?: Entry[];
}

interface Body {
  lines: string[];
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

const PROJECT_TABS = [
  ["decision", "Decisions"],
  ["lesson", "Lessons"],
  ["note", "Notes"],
] as const;

export class NotebookView {
  private tab = 0;
  private offset = 0;
  private selected = 0;
  private open = new Set<string>();
  private showInactive = false;

  constructor(
    private data: ViewData,
    private th: Theme,
    private tui: ViewTui,
    private onClose: () => void,
  ) {}

  private tabs(): Tab[] {
    const { data } = this;
    const tabs: Tab[] = [{ id: "overview", label: "Overview" }];
    if (data.scope)
      for (const [kind, label] of PROJECT_TABS)
        tabs.push({
          id: kind,
          label,
          entries: data.projectEntries.filter((e) => e.kind === kind),
        });
    tabs.push({ id: "global", label: "Global", entries: data.globalEntries });
    tabs.push({ id: "rules", label: "Rules" });
    return tabs;
  }

  private listed(tab: Tab): Entry[] {
    return (tab.entries ?? [])
      .filter((e) => this.showInactive || e.status === "active")
      .sort(newestFirst);
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
    const items = isList ? this.listed(tab) : [];
    const move = (by: number) => {
      if (isList)
        this.selected = Math.max(
          0,
          Math.min(this.selected + by, items.length - 1),
        );
      else this.offset = Math.max(0, this.offset + by);
    };
    const page = isList ? 5 : this.bodyHeight() - 1;

    if (matchesKey(key, "escape") || matchesKey(key, "ctrl+c") || key === "q")
      return this.onClose();
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
      }
    } else if (isList && key === "x") {
      this.showInactive = !this.showInactive;
      this.selected = 0;
    } else return;
    this.tui.requestRender();
  }

  invalidate(): void {}

  render(width: number): string[] {
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
          ? ` ${t.entries.filter((e) => e.status === "active").length}`
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
    const pos =
      body.lines.length > height
        ? `${this.offset + 1}–${this.offset + shown.length} of ${body.lines.length} lines · `
        : "";
    const keys = tab.entries
      ? "↑↓ select · enter open · x retired · ←→ tab · esc close"
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
    const items = this.listed(tab);
    if (items.length === 0) {
      const hint =
        tab.id === "note" ? ` ${th.fg("dim", "try")} ${th.fg("accent", "/nb:learn")}` : "";
      return { lines: [`    ${th.fg("dim", "none yet")}${hint}`] };
    }
    this.selected = Math.min(this.selected, items.length - 1);
    const lines: string[] = [];
    let anchor: [number, number] | undefined;
    items.forEach((e, i) => {
      const start = lines.length;
      const active = e.status === "active";
      const state = active
        ? ""
        : ` [${e.status === "retired" && e.retiredReason ? `retired: ${e.retiredReason}` : e.status}]`;
      const mark = i === this.selected ? th.fg("accent", "▸") : " ";
      lines.push(
        ...hang(
          ` ${mark} ${th.fg("accent", ref(e).padEnd(5))} `,
          `${th.fg(active ? "text" : "dim", e.title)}  ${th.fg("dim", e.date + state)}`,
          width,
        ),
      );
      if (this.open.has(e.path)) lines.push(...this.detail(e, width));
      if (i === this.selected) anchor = [start, lines.length - 1];
    });
    return { lines, anchor };
  }

  private detail(e: Entry, width: number): string[] {
    const { th } = this;
    const pad = "        ";
    const out: string[] = [];
    if (e.kind === "note" && e.files?.length)
      out.push(...hang(pad, th.fg("dim", `Files: ${e.files.join(", ")}`), width));
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
      }
      lines.push("");

      for (const [kind, label] of PROJECT_TABS) {
        const all = data.projectEntries.filter((e) => e.kind === kind);
        const active = all.filter((e) => e.status === "active").sort(newestFirst);
        const inactive = all.length - active.length;
        lines.push(
          heading(th, label, `${active.length} active${inactive ? ` · ${inactive} retired or superseded` : ""}`),
        );
        for (const e of active.slice(0, 3))
          lines.push(
            ...hang(
              `    ${th.fg("accent", ref(e).padEnd(5))} `,
              th.fg("text", e.title),
              width,
            ),
          );
        if (active.length > 3)
          lines.push(`    ${th.fg("dim", `… ${active.length - 3} more in the ${label} tab`)}`);
        if (active.length === 0)
          lines.push(
            `    ${th.fg("dim", "none yet")}${kind === "note" ? ` ${th.fg("dim", "try")} ${th.fg("accent", "/nb:learn")}` : ""}`,
          );
        lines.push("");
      }
    }

    const g = counts(data.globalEntries);
    lines.push(
      heading(
        th,
        "Global",
        `${g.l} environment · ${g.d} decisions · ${data.preferences.length} preferences`,
      ),
      "",
      `  ${th.fg("dim", "injected")} ${th.fg("muted", `≈${data.injectedTokens} tokens/turn`)}`,
    );
    return { lines };
  }
}
