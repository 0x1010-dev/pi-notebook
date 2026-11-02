export type NudgeKind = "context" | "milestone";

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

export function nudgeText(kind: NudgeKind): string {
  const body = kind === "context"
    ? "Context will be compacted later. Save only worthwhile durable knowledge and reconcile the handoff for unfinished work. Saving no new memories is fine."
    : "Work was committed. If there is worthwhile durable knowledge, save the conclusion or update its existing memory. Reconcile the handoff if unfinished work changed. Otherwise ignore this note.";
  return `[pi-notebook] ${body} Do this at a natural stopping point, not in the middle of a step.`;
}
