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

/** Highest band index whose threshold `percent` has reached, or -1 below all bands. */
export function bandIndex(percent: number, bands: number[]): number {
  let i = -1;
  for (let b = 0; b < bands.length; b++) if (percent >= bands[b]) i = b;
  return i;
}

export const SAVE_BAND = 0;
export const HANDOFF_BAND = 1;
export const COMPACT_BAND = 2;

export function usageText(percent: number): string {
  return `[pi-notebook] Context ${Math.round(percent)}% used.`;
}

export function bandText(
  percent: number,
  band: number,
  opts: { handoff: boolean; compactTool: boolean },
): string {
  const p = Math.round(percent);
  const b = opts.handoff ? band : SAVE_BAND;
  if (b === SAVE_BAND)
    return `[pi-notebook] Context ${p}%. Consider saving any durable knowledge worth keeping.`;
  if (b === HANDOFF_BAND)
    return `[pi-notebook] Context ${p}%. Consider updating the handoff if progress has changed.`;
  return opts.compactTool
    ? `[pi-notebook] Context ${p}%. Compaction is near. At the next clean stopping point, update the handoff and call context_compact.`
    : `[pi-notebook] Context ${p}%. Compaction is near. At the next clean stopping point, update the handoff.`;
}
