import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Project, Scope } from "./paths.ts";
import type { Hint } from "./signals.ts";
import { type Entry, type Handoff, ref } from "./store.ts";

export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

const STALE_MS = 24 * 60 * 60 * 1000;

export interface StatusInfo {
  project?: Project;
  scope?: Scope;
  projectEntries: Entry[];
  globalEntries: Entry[];
  handoff?: Handoff;
  hint?: Hint;
}

function counts(entries: Entry[]): { d: number; l: number } {
  const active = entries.filter((e) => e.status === "active");
  return {
    d: active.filter((e) => e.kind === "decision").length,
    l: active.filter((e) => e.kind === "lesson").length,
  };
}

function summary(th: Theme, entries: Entry[]): string {
  const c = counts(entries);
  return `${th.fg("text", `${c.d}d`)} ${th.fg("text", `${c.l}l`)}`;
}

/** Footer status, e.g. `◆ 📓 · 3d 5l · handoff updated 2h ago · Tip: /nb:wrap to record finished work` */
export function statusLine(th: Theme, s: StatusInfo): string {
  const sep = th.fg("dim", " · ");
  const lit = !!s.scope || s.globalEntries.length > 0;
  const parts = [
    `${th.fg(lit ? "accent" : "dim", lit ? "◆" : "◇")} ${th.fg(lit ? "muted" : "dim", "📓")}`,
  ];
  let tip = s.hint;

  if (s.scope) {
    parts.push(summary(th, s.projectEntries));
    if (s.handoff?.updated) {
      const age = ago(s.handoff.updated);
      const stale = Date.now() - Date.parse(s.handoff.updated) > STALE_MS;
      parts.push(
        stale
          ? th.fg("warning", `handoff ${age} old`)
          : th.fg(
              "muted",
              `handoff updated ${age === "0m" ? "just now" : `${age} ago`}`,
            ),
      );
    } else {
      parts.push(th.fg("dim", "no handoff"));
    }
  } else if (s.project) {
    parts.push(th.fg("dim", "not set up"));
    tip ??= { command: "/nb:init", reason: "to start one" };
  } else if (lit) {
    parts.push(`${th.fg("muted", "global")} ${summary(th, s.globalEntries)}`);
  } else {
    parts.push(th.fg("dim", "empty"));
  }
  if (tip) {
    const color = s.hint ? "accent" : "dim";
    parts.push(
      `${th.fg("dim", "Tip:")} ${th.fg(color, tip.command)} ${th.fg("dim", tip.reason)}`,
    );
  }
  return parts.join(sep);
}

export interface ViewData extends StatusInfo {
  preferences: string[];
  conventions: string[];
  injectedTokens: number;
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

function entryRows(th: Theme, entries: Entry[], max: number): string[] {
  const active = entries
    .filter((e) => e.status === "active")
    .sort((a, b) => b.id - a.id);
  const rows = active
    .slice(0, max)
    .map(
      (e) =>
        `    ${th.fg("accent", ref(e).padEnd(5))} ${th.fg("text", e.title)}  ${th.fg("dim", e.date)}`,
    );
  if (active.length > max)
    rows.push(`    ${th.fg("dim", `… ${active.length - max} more`)}`);
  if (rows.length === 0) rows.push(`    ${th.fg("dim", "none yet")}`);
  return rows;
}

export class NotebookView {
  private cache?: { width: number; lines: string[] };

  constructor(
    private data: ViewData,
    private th: Theme,
    private onClose: () => void,
  ) {}

  handleInput(key: string): void {
    if (
      matchesKey(key, "escape") ||
      matchesKey(key, "ctrl+c") ||
      key === "q" ||
      matchesKey(key, "enter")
    )
      this.onClose();
  }

  invalidate(): void {
    this.cache = undefined;
  }

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines;
    const { th, data } = this;
    const lines: string[] = [""];
    const where = data.project
      ? `${data.project.name}${data.scope ? ` · ${data.scope.mode}` : ""}`
      : "global";
    lines.push(rule(th, width, "Notebook", where), "");

    if (data.project && !data.scope) {
      lines.push(
        `  ${th.fg("dim", "No notebook for this project. Run")} ${th.fg("accent", "/nb:init")} ${th.fg("dim", "or save something.")}`,
        "",
      );
    }

    if (data.scope) {
      const h = data.handoff;
      lines.push(
        heading(
          th,
          "Handoff",
          h?.updated ? `updated ${ago(h.updated)} ago` : "",
        ),
      );
      if (!h) {
        lines.push(`    ${th.fg("dim", "none yet")}`);
      } else {
        const field = (label: string, value: string) =>
          `    ${th.fg("muted", label.padEnd(8))}${th.fg("text", value)}`;
        if (h.goal) lines.push(field("goal", h.goal));
        if (h.status) lines.push(field("status", h.status));
        h.nextSteps.forEach((s, i) =>
          lines.push(
            `    ${th.fg("muted", (i === 0 ? "next" : "").padEnd(8))}${th.fg("accent", "›")} ${th.fg("text", s)}`,
          ),
        );
        h.blockers.forEach((s, i) =>
          lines.push(
            `    ${th.fg("muted", (i === 0 ? "blocked" : "").padEnd(8))}${th.fg("warning", "!")} ${th.fg("text", s)}`,
          ),
        );
        h.todos.forEach((s, i) =>
          lines.push(
            `    ${th.fg("muted", (i === 0 ? "todos" : "").padEnd(8))}${th.fg("dim", s)}`,
          ),
        );
      }
      lines.push("");
      const c = counts(data.projectEntries);
      const superseded = data.projectEntries.length - c.d - c.l;
      lines.push(
        heading(
          th,
          "Decisions",
          `${c.d} active${superseded ? ` · ${superseded} superseded` : ""}`,
        ),
      );
      lines.push(
        ...entryRows(
          th,
          data.projectEntries.filter((e) => e.kind === "decision"),
          6,
        ),
        "",
      );
      lines.push(heading(th, "Lessons", `${c.l} active`));
      lines.push(
        ...entryRows(
          th,
          data.projectEntries.filter((e) => e.kind === "lesson"),
          6,
        ),
        "",
      );
      if (data.conventions.length) {
        lines.push(heading(th, "Conventions", `${data.conventions.length}`));
        lines.push(
          ...data.conventions
            .slice(0, 6)
            .map((c) => `    ${th.fg("dim", "•")} ${th.fg("text", c)}`),
          "",
        );
      }
    }

    const g = counts(data.globalEntries);
    lines.push(
      heading(
        th,
        "Global",
        `${g.l} lessons · ${g.d} decisions · ${data.preferences.length} preferences`,
      ),
    );
    lines.push(...entryRows(th, data.globalEntries, 6));
    lines.push(
      ...data.preferences
        .slice(-4)
        .map((p) => `    ${th.fg("dim", "•")} ${th.fg("muted", p)}`),
      "",
    );

    lines.push(
      `  ${th.fg("dim", "injected")} ${th.fg("muted", `≈${data.injectedTokens} tokens/turn`)}`,
    );
    if (data.hint)
      lines.push(
        `  ${th.fg("accent", `▸ ${data.hint.command}`)}  ${th.fg("dim", data.hint.reason)}`,
      );
    lines.push("", `  ${th.fg("dim", "esc close")}`, "");

    const out = lines.map((l) => truncateToWidth(l, width));
    this.cache = { width, lines: out };
    return out;
  }
}
