import { staleness } from "./git.ts";
import { findProject } from "./paths.ts";
import { type Entry, preview, ref } from "./store.ts";

export const entryPreview = preview;

export const clip = (s: string, max: number): string =>
  s.length > max ? `${s.slice(0, max)}…` : s;

/** `M3 Title` */
export function entryLabel(e: Entry): string {
  return `${ref(e)} ${e.title}`;
}

/** A reference, title and timestamp. */
export function entryHead(e: Entry): string {
  return `${ref(e)} ${e.title} (${e.date})`;
}

/** Retrieval metadata and code-staleness warnings. */
export function noteLines(cwd: string, e: Entry): string[] {
  const lines = metadataLines(e);
  const root = findProject(cwd)?.root;
  const warn =
    root && e.commit ? staleness(root, e.commit, e.files) : undefined;
  if (warn) lines.push(warn);
  return lines;
}

export function metadataLines(e: Entry): string[] {
  return [
    ...(e.tags.length ? [`Tags: ${e.tags.map((t) => `#${t}`).join(" ")}`] : []),
    ...(e.files?.length ? [`Files: ${e.files.join(", ")}`] : []),
  ];
}
