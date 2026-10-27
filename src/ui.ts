import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Project, Scope } from "./paths.ts";
import type { Entry, Handoff } from "./store.ts";

export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const min = Math.max(0, Math.round((now - t) / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export const STALE_MS = 24 * 60 * 60 * 1000;

export interface StatusInfo {
  project?: Project;
  scope?: Scope;
  projectEntries: Entry[];
  globalEntries: Entry[];
  handoff?: Handoff;
}

export function counts(entries: Entry[]): { d: number; l: number; n: number } {
  const active = entries.filter((e) => e.status === "active");
  return {
    d: active.filter((e) => e.kind === "decision").length,
    l: active.filter((e) => e.kind === "lesson").length,
    n: active.filter((e) => e.kind === "note").length,
  };
}

function summary(th: Theme, entries: Entry[]): string {
  const c = counts(entries);
  const notes = c.n ? ` ${th.fg("text", `${c.n}n`)}` : "";
  return `${th.fg("text", `${c.d}d`)} ${th.fg("text", `${c.l}l`)}${notes}`;
}

/** Footer status, e.g. `◆ NB · 3d 5l · handoff updated 2h ago` */
export function statusLine(th: Theme, s: StatusInfo): string {
  const sep = th.fg("dim", " · ");
  const lit = !!s.scope || s.globalEntries.length > 0;
  const parts = [
    `${th.fg(lit ? "accent" : "dim", lit ? "◆" : "◇")} ${th.fg(lit ? "muted" : "dim", "NB")}`,
  ];

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
  } else if (lit) {
    parts.push(`${th.fg("muted", "global")} ${summary(th, s.globalEntries)}`);
  } else {
    parts.push(th.fg("dim", "empty"));
  }
  return parts.join(sep);
}
