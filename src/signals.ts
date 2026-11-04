import type { ContextBands } from "./config.ts";

const PREFERENCE_RE =
  /\b(from now on|going forward|in the future|i prefer|i'd rather|i would rather|always use|never use|remember (?:that|to)|make sure (?:you|to) always)\b/i;

export function looksLikePreference(text: string): boolean {
  return PREFERENCE_RE.test(text);
}

const RESUME_RE =
  /\b(where (?:did|were|are) we|where we (?:left|ended|stopped)|left off|where things stand|pick (?:it |this )?(?:back )?up|resume|continue|carry on|what'?s next|next steps?|the plan|yesterday|last (?:time|session)|catch me up)\b/i;

export function looksLikeResume(text: string): boolean {
  return RESUME_RE.test(text);
}

export const COMMIT_RE = /\bgit\b[^\n|;&]*\bcommit\b/;

export const PREFERENCE_NUDGE =
  "[pi-notebook] If the user clearly stated a lasting instruction that is not recorded, use memory_save with kind rule. Keep it short; the user confirms it. Otherwise ignore this note.";

export const MILESTONE_NUDGE =
  "[pi-notebook] Work was committed. If there is worthwhile durable knowledge, save the conclusion or update its existing memory. Reconcile the handoff if unfinished work changed. Otherwise ignore this note. Do this at a natural stopping point, not in the middle of a step.";

export type ContextBand = keyof ContextBands;

/** Highest band whose threshold `percent` has reached. */
export function contextBand(percent: number, bands: ContextBands | false): ContextBand | undefined {
  if (bands === false) return undefined;
  if (percent >= bands.compact) return "compact";
  if (percent >= bands.handoff) return "handoff";
  if (percent >= bands.save) return "save";
  return undefined;
}

export function usageText(percent: number): string {
  return `[pi-notebook] Context window ${Math.round(percent)}% full.`;
}

export function resumeText(percent: number | undefined): string {
  const usage = percent === undefined ? "" : ` Context window is now ${Math.round(percent)}% full.`;
  return `[pi-notebook] Compaction is complete.${usage} Earlier messages are already handled; continue from the handoff's next steps.`;
}

export function bandText(
  percent: number,
  band: ContextBand,
  opts: { handoff: boolean; compactTool: boolean },
): string {
  const usage = usageText(percent);
  const kind = opts.handoff ? band : "save";
  if (kind === "save")
    return `${usage} Consider saving any durable knowledge worth keeping.`;
  if (kind === "handoff")
    return `${usage} Consider updating the handoff if progress has changed.`;
  return opts.compactTool
    ? `${usage} Compaction is near. At the next clean stopping point, update the handoff and call context_compact.`
    : `${usage} Compaction is near. At the next clean stopping point, update the handoff.`;
}
