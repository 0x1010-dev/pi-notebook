export type NudgeKind = "milestone" | "lesson" | "handoff" | "checkpoint";

export interface RunFacts {
  committed: boolean;
  /** At least one failed tool call followed by a later success. */
  recovered: boolean;
  /** Todos went from open to all completed during the run. */
  todosFinished: boolean;
  /** A notebook tool saved something during the run. */
  saved: boolean;
}

export function freshRun(): RunFacts {
  return {
    committed: false,
    recovered: false,
    todosFinished: false,
    saved: false,
  };
}

const PREFERENCE_RE =
  /\b(always|never|from now on|going forward|in the future|i prefer|prefer(?:s|red)? (?:to|using)|i'd rather|i would rather|instead of|i like (?:it|to|when)|remember (?:that|to)|make sure (?:you|to) always)\b/i;

export function looksLikePreference(text: string): boolean {
  return PREFERENCE_RE.test(text);
}

export const COMMIT_RE = /\bgit\b[^\n|;&]*\bcommit\b/;

export const HANDOFF_AFTER_RUNS = 3;

/** Highest-priority nudge for a finished run, if any. */
export function detectNudge(
  facts: RunFacts,
  runsSinceSave: number,
  checkpointRuns: number,
  handoffMissing = false,
): NudgeKind | undefined {
  if (facts.saved) return undefined;
  if (facts.committed || facts.todosFinished) return "milestone";
  if (facts.recovered) return "lesson";
  if (handoffMissing && runsSinceSave >= HANDOFF_AFTER_RUNS) return "handoff";
  if (runsSinceSave >= checkpointRuns) return "checkpoint";
  return undefined;
}

export const PREFERENCE_NUDGE =
  "[pi-notebook] The user's message may state a lasting preference or repo rule. If it clearly does and is not already recorded, call memory_save once (kind preference or convention). Otherwise ignore this note.";

export const NUDGE_TEXT: Record<NudgeKind, string> = {
  milestone:
    "[pi-notebook] A unit of work finished in the previous run. If it involved a choice between real alternatives or solved a non-obvious problem, record it with memory_save, and call handoff_update with the new state. Otherwise ignore this note.",
  lesson:
    "[pi-notebook] The previous run recovered from failing tool calls. If the cause and fix are non-obvious and likely to recur, record them with memory_save kind lesson. Otherwise ignore this note.",
  handoff:
    "[pi-notebook] This project has no handoff yet. If there is a goal or plan in progress, call handoff_update now so a later session can resume it. Otherwise ignore this note.",
  checkpoint:
    "[pi-notebook] Many runs since the last notebook update. If the work state changed, call handoff_update. Otherwise ignore this note.",
};

export interface Hint {
  command: string;
  reason: string;
}

export const NUDGE_HINT: Record<NudgeKind, Hint> = {
  milestone: { command: "/nb:wrap", reason: "to record finished work" },
  lesson: { command: "/nb:wrap", reason: "to record the fix" },
  handoff: { command: "/nb:wrap", reason: "to save the plan" },
  checkpoint: { command: "/nb:wrap", reason: "to save progress" },
};
