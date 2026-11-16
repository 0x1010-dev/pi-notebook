import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Project, Scope } from "./paths.ts";
import type { Entry, Handoff, MemoryDiagnostic } from "./store.ts";

export function ago(iso: string, now = Date.now()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) {
    return "?";
  }
  const minutes = Math.max(0, Math.round((now - timestamp) / 60000));
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
}

export const STALE_MS = 24 * 60 * 60 * 1000;

export interface StatusInfo {
  project?: Project;
  scope?: Scope;
  projectEntries: Entry[];
  globalEntries: Entry[];
  handoff?: Handoff;
  diagnostics?: MemoryDiagnostic[];
}

export function counts(entries: Entry[]): number {
  return entries.length;
}

function summary(theme: Theme, entries: Entry[]): string {
  const active = counts(entries);
  return theme.fg("text", `${active} active`);
}

/** Footer status, e.g. `◆ NB · 8 active · handoff updated 2h ago` */
export function statusLine(theme: Theme, status: StatusInfo): string {
  const separator = theme.fg("dim", " · ");
  const hasNotebook = !!status.scope || status.globalEntries.length > 0;
  const parts = [
    `${theme.fg(hasNotebook ? "accent" : "dim", hasNotebook ? "◆" : "◇")} ${theme.fg(hasNotebook ? "muted" : "dim", "NB")}`,
  ];
  if (status.diagnostics?.length) {
    parts.push(
      theme.fg("warning", `${status.diagnostics.length} files need repair`),
    );
  }

  if (status.scope) {
    parts.push(summary(theme, status.projectEntries));
    if (status.handoff?.updated) {
      const age = ago(status.handoff.updated);
      const stale = Date.now() - Date.parse(status.handoff.updated) > STALE_MS;
      parts.push(
        stale
          ? theme.fg("warning", `handoff ${age} old`)
          : theme.fg(
              "muted",
              `handoff updated ${age === "0m" ? "just now" : `${age} ago`}`,
            ),
      );
    } else {
      parts.push(theme.fg("dim", "no handoff"));
    }
  } else if (status.project) {
    parts.push(theme.fg("dim", "not set up"));
  } else if (hasNotebook) {
    parts.push(
      `${theme.fg("muted", "global")} ${summary(theme, status.globalEntries)}`,
    );
  } else {
    parts.push(theme.fg("dim", "empty"));
  }
  return parts.join(separator);
}
