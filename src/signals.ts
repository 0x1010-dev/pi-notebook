export type NudgeKind =
  | "context"
  | "milestone"
  | "lesson"
  | "handoff"
  | "checkpoint";

/** Events observed since the last save or the nudge that consumed them. */
export interface Signals {
  committed: boolean;
  /** At least two failed tool calls followed by a success. */
  recovered: boolean;
}

export function freshSignals(): Signals {
  return { committed: false, recovered: false };
}

export interface TurnFacts extends Signals {
  contextHigh: boolean;
  handoffMissing: boolean;
  turnsSinceSave: number;
}

export interface NudgePolicy {
  checkpointTurns: number;
  handoffAfterTurns: number;
  cooldownTurns: number;
}

const PREFERENCE_RE =
  /\b(from now on|going forward|in the future|i prefer|i'd rather|i would rather|always use|never use|remember (?:that|to)|make sure (?:you|to) always)\b/i;

export function looksLikePreference(text: string): boolean {
  return PREFERENCE_RE.test(text);
}

const RESUME_RE =
  /\b(where (?:did|were|are) we|where we (?:left|ended|stopped)|left off|where things stand|pick (?:it |this )?(?:back )?up|resume|continue|carry on|what'?s next|next steps?|the plan|yesterday|last (?:time|session)|catch me up)\b/i;

/** The prompt asks to resume or report on ongoing work. */
export function looksLikeResume(text: string): boolean {
  return RESUME_RE.test(text);
}

export const COMMIT_RE = /\bgit\b[^\n|;&]*\bcommit\b/;

/**
 * Highest-priority nudge for a finished turn. Each kind fires once until the next save,
 * and only `context` may bypass the cooldown.
 */
export function detectNudge(
  f: TurnFacts,
  policy: NudgePolicy,
  fired: ReadonlySet<NudgeKind>,
  turnsSinceNudge: number,
): NudgeKind | undefined {
  const candidates: [NudgeKind, boolean][] = [
    ["context", f.contextHigh],
    ["milestone", f.committed],
    ["lesson", f.recovered],
    [
      "handoff",
      f.handoffMissing && f.turnsSinceSave >= policy.handoffAfterTurns,
    ],
    ["checkpoint", f.turnsSinceSave >= policy.checkpointTurns],
  ];
  for (const [kind, on] of candidates) {
    if (!on || fired.has(kind)) continue;
    if (kind !== "context" && turnsSinceNudge < policy.cooldownTurns)
      return undefined;
    return kind;
  }
  return undefined;
}

export const PREFERENCE_NUDGE =
  "[pi-notebook] The user's message may state a lasting preference or repo rule. If it clearly does and is not already recorded, call memory_save once (kind preference or convention). Otherwise ignore this note.";

const LATER =
  "Do it at the next natural stopping point; finish your current step first.";

export function nudgeText(kind: NudgeKind): string {
  const body: Record<NudgeKind, string> = {
    context:
      "The context window is filling up and will be compacted later, which drops details. Record any decisions or non-obvious fixes from this session with memory_save, and update the handoff with handoff_update.",
    milestone:
      "A piece of work was just committed. If it involved a choice between real alternatives or solved a non-obvious problem, record it with memory_save, and update the handoff with handoff_update. Otherwise ignore this note.",
    lesson:
      "Recent tool calls failed before succeeding. If the cause and fix are non-obvious and likely to recur, record them with memory_save kind lesson (kind environment only if the cause is the user's own machine or accounts). If a lesson already covers it, update that one by ref. Otherwise ignore this note.",
    handoff:
      "This project has no handoff yet. If there is a goal or plan in progress, call handoff_update so a later session can resume it. Otherwise ignore this note.",
    checkpoint:
      "Nothing has been saved to the notebook in a while. If the work state changed, call handoff_update. Otherwise ignore this note.",
  };
  return `[pi-notebook] ${body[kind]} ${LATER}`;
}
