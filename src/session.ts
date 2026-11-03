import { loadConfig } from "./config.ts";
import { COMMIT_RE, type NudgeKind } from "./signals.ts";

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
}

/** Everything that changes while a session runs. */
export class Session {
  cfg = loadConfig();
  pendingNudge: NudgeKind | undefined;
  suppressNudgeOnce = false;
  handoffShown = false;
  recalled = new Map<string, string>();
  snapshot: Snapshot | undefined;
  snapshotFingerprint: string | undefined;
  loadWarning = "";
  /** Guard warnings keyed by tool call id, appended to that call's result. */
  readonly warnings = new Map<string, string>();

  private committed = false;
  private turnsSinceNudge = 0;
  private contextNudged = false;

  /** Start of a session: reload config and clear all per-session state. */
  reset(): void {
    this.cfg = loadConfig();
    this.invalidate();
    this.recalled = new Map();
    this.handoffShown = false;
    this.pendingNudge = undefined;
    this.suppressNudgeOnce = false;
    this.warnings.clear();
    this.loadWarning = "";
    this.committed = false;
    this.turnsSinceNudge = this.cfg.nudgeCooldownTurns;
    this.contextNudged = false;
  }

  /** Compaction drops earlier context, so re-inject and allow nudges again. */
  onCompact(): void {
    this.invalidate();
    this.recalled.clear();
    this.pendingNudge = undefined;
    this.contextNudged = false;
    this.handoffShown = false;
  }

  invalidate(): void {
    this.snapshot = undefined;
    this.snapshotFingerprint = undefined;
  }

  /** Something durable was written, so earlier nudges are satisfied. */
  markSaved(): void {
    this.committed = false;
    this.pendingNudge = undefined;
    this.invalidate();
  }

  recordToolResult(toolName: string, command: unknown, isError: boolean): void {
    if (
      toolName === "bash" &&
      !isError &&
      COMMIT_RE.test(String(command ?? ""))
    )
      this.committed = true;
  }

  /** Advances turn counters and returns the nudge to send, updating state for it. */
  endTurn(input: TurnInput): NudgeKind | undefined {
    this.turnsSinceNudge++;
    const { cfg } = this;
    const high = cfg.wrapAtContextPercent > 0 && !this.contextNudged &&
      input.contextPercent >= cfg.wrapAtContextPercent;
    const kind = high ? "context" : this.committed &&
      this.turnsSinceNudge >= cfg.nudgeCooldownTurns ? "milestone" : undefined;
    if (!kind) return undefined;
    this.turnsSinceNudge = 0;
    if (kind === "context") this.contextNudged = true;
    if (kind === "milestone") this.committed = false;
    return kind;
  }
}
