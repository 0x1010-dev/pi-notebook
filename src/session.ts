import { HINT_TTL_RUNS } from "./constants.ts";
import { loadConfig } from "./config.ts";
import {
  COMMIT_RE,
  detectNudge,
  freshSignals,
  type Hint,
  NUDGE_HINT,
  type NudgeKind,
} from "./signals.ts";

export interface ContextFile {
  path: string;
  content: string;
  where: "start" | "end";
}

/** Injected prompt pieces, frozen per session so the system prompt prefix (and KV cache) stays stable. */
export interface Snapshot {
  section: string;
  files: ContextFile[];
}

export interface TurnInput {
  contextPercent: number;
  handoffMissing: boolean;
}

/** Everything that changes while a session runs. */
export class Session {
  cfg = loadConfig();
  hint: Hint | undefined;
  pendingNudge: NudgeKind | undefined;
  suppressNudgeOnce = false;
  handoffShown = false;
  recalled = new Set<string>();
  snapshot: Snapshot | undefined;
  /** Guard warnings keyed by tool call id, appended to that call's result. */
  readonly warnings = new Map<string, string>();

  private hintAge = 0;
  private signals = freshSignals();
  private fired = new Set<NudgeKind>();
  private turnsSinceSave = 0;
  private turnsSinceNudge = 0;
  private errorsSinceSuccess = 0;
  private contextNudged = false;

  /** Start of a session: reload config and clear all per-session state. */
  reset(): void {
    this.cfg = loadConfig();
    this.invalidate();
    this.recalled = new Set();
    this.handoffShown = false;
    this.setHint(undefined);
    this.pendingNudge = undefined;
    this.signals = freshSignals();
    this.fired = new Set();
    this.turnsSinceSave = 0;
    this.turnsSinceNudge = this.cfg.nudgeCooldownTurns;
    this.errorsSinceSuccess = 0;
    this.contextNudged = false;
  }

  /** Compaction drops earlier context, so re-inject and allow nudges again. */
  onCompact(): void {
    this.invalidate();
    this.contextNudged = false;
    this.fired.delete("context");
    this.handoffShown = false;
  }

  invalidate(): void {
    this.snapshot = undefined;
  }

  setHint(next: Hint | undefined): void {
    this.hint = next;
    this.hintAge = 0;
  }

  clearHintIf(command: string): void {
    if (this.hint?.command === command) this.setHint(undefined);
  }

  /** Counts one finished agent run toward hint expiry. */
  ageHint(): void {
    if (this.hint && ++this.hintAge >= HINT_TTL_RUNS) this.setHint(undefined);
  }

  /** Something durable was written, so earlier nudges are satisfied. */
  markSaved(): void {
    this.turnsSinceSave = 0;
    this.fired = new Set();
    this.signals = freshSignals();
    if (this.hint && this.hint.command !== "/nb:curate") this.setHint(undefined);
  }

  recordToolResult(toolName: string, command: unknown, isError: boolean): void {
    if (toolName === "bash" && !isError && COMMIT_RE.test(String(command ?? "")))
      this.signals.committed = true;
    if (isError) {
      this.errorsSinceSuccess++;
      return;
    }
    if (this.errorsSinceSuccess >= 2) this.signals.recovered = true;
    this.errorsSinceSuccess = 0;
  }

  /** Advances turn counters and returns the nudge to send, updating state and hint for it. */
  endTurn(input: TurnInput): NudgeKind | undefined {
    this.turnsSinceSave++;
    this.turnsSinceNudge++;
    const { cfg } = this;
    const kind = detectNudge(
      {
        ...this.signals,
        contextHigh:
          cfg.wrapAtContextPercent > 0 &&
          !this.contextNudged &&
          input.contextPercent >= cfg.wrapAtContextPercent,
        handoffMissing: input.handoffMissing,
        turnsSinceSave: this.turnsSinceSave,
      },
      {
        checkpointTurns: cfg.checkpointTurns,
        handoffAfterTurns: cfg.handoffAfterTurns,
        cooldownTurns: cfg.nudgeCooldownTurns,
      },
      this.fired,
      this.turnsSinceNudge,
    );
    if (!kind) return undefined;
    this.fired.add(kind);
    this.turnsSinceNudge = 0;
    if (kind === "context") this.contextNudged = true;
    if (kind === "milestone") this.signals.committed = false;
    if (kind === "lesson") this.signals.recovered = false;
    this.setHint(NUDGE_HINT[kind]);
    return kind;
  }
}
