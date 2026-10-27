import { findProject } from "./paths.ts";
import { staleness } from "./git.ts";
import { type Entry, ref } from "./store.ts";

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** `D3 Title` */
export function entryLabel(e: Entry): string {
  return `${ref(e)} ${e.title}`;
}

/** `D3 [active] Title (2026-01-02)` */
export function entryHead(e: Entry): string {
  const state =
    e.status === "superseded" && e.supersededBy
      ? `superseded by ${e.supersededBy}`
      : e.status === "retired" && e.retiredReason
        ? `retired: ${e.retiredReason}`
        : e.status;
  return `${ref(e)} [${state}] ${e.title} (${e.date})`;
}

/** Files line and staleness warning for notes; empty for other kinds. */
export function noteLines(cwd: string, e: Entry): string[] {
  if (e.kind !== "note") return [];
  const lines = e.files?.length ? [`Files: ${e.files.join(", ")}`] : [];
  const root = findProject(cwd)?.root;
  const warn = root && e.commit ? staleness(root, e.commit, e.files) : undefined;
  if (warn) lines.push(warn);
  return lines;
}
