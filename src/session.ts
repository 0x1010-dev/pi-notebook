import { loadConfig } from "./config.ts";
import type { ManagedWriteSnapshot } from "./guard.ts";
import { contextBand, COMMIT_RE, type ContextBand } from "./signals.ts";

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
  /** Hidden note text waiting for the next user prompt. */
  pendingNudge: string | undefined;
  suppressNudgeOnce = false;
  handoffShown = false;
  recalled = new Map<string, string>();
  snapshot: Snapshot | undefined;
  snapshotFingerprint: string | undefined;
  loadWarning = "";
  /** Managed sections before file writes, keyed by tool call id. */
  readonly managedWrites = new Map<string, ManagedWriteSnapshot>();
  /** Turns elapsed in this session. */
  turn = 0;
  /** Turn when this session last saved the handoff. */
  handoffTurn: number | undefined;
  /** Set by context_compact; consumed by the agent_settled handler. */
  compactPending = false;
  /** Set once compaction completes for a scheduled context_compact; tells agent_settled to continue the work. */
  resumePending = false;
  /** Auto-continue cycles used so far this session. */
  compactCycles = 0;
  /** The handoff is already the compaction summary, so it should not be shown again as a resume note. */
  handoffCompacted = false;

  private committed = false;
  private lastNudgeTurn = 0;
  private bandNoted = -1;

  /** Start of a session: reload config and clear all per-session state. */
  reset(): void {
    this.cfg = loadConfig();
    this.invalidate();
    this.recalled = new Map();
    this.handoffShown = false;
    this.pendingNudge = undefined;
    this.suppressNudgeOnce = false;
    this.managedWrites.clear();
    this.loadWarning = "";
    this.committed = false;
    this.turn = 0;
    this.lastNudgeTurn = -this.cfg.nudgeCooldownTurns;
    this.bandNoted = -1;
    this.handoffTurn = undefined;
    this.compactPending = false;
    this.resumePending = false;
    this.compactCycles = 0;
    this.handoffCompacted = false;
  }

  /** Compaction drops earlier context, so re-inject and allow nudges again. */
  onCompact(): void {
    this.resumePending = this.compactPending;
    this.invalidate();
    this.recalled.clear();
    this.pendingNudge = undefined;
    this.bandNoted = -1;
    this.compactPending = false;
    if (this.handoffCompacted) {
      this.handoffShown = true;
      this.handoffCompacted = false;
    } else {
      this.handoffShown = false;
    }
  }

  /** Compaction never happened, so the handoff is not a compaction summary and nothing is pending. */
  onCompactFailed(): void {
    this.handoffCompacted = false;
    this.compactPending = false;
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

  /** Returns the highest band newly reached since the last compaction. */
  crossBand(percent: number): ContextBand | undefined {
    const band = contextBand(percent, this.cfg.contextBands);
    if (band === undefined || this.cfg.contextBands === false) return undefined;
    const threshold = this.cfg.contextBands[band];
    if (threshold <= this.bandNoted) return undefined;
    this.bandNoted = threshold;
    return band;
  }

  /** This session saved the handoff at the current turn. */
  markHandoff(): void {
    this.handoffTurn = this.turn;
  }

  /** Whether this session's handoff was saved recently enough to trust as a compaction summary. */
  handoffFresh(): boolean {
    return this.handoffTurn !== undefined &&
      this.turn - this.handoffTurn <= this.cfg.handoffStaleTurns;
  }

  recordToolResult(toolName: string, command: unknown, isError: boolean): void {
    if (
      toolName === "bash" &&
      !isError &&
      COMMIT_RE.test(String(command ?? ""))
    )
      this.committed = true;
  }

  /** Advances the turn and returns whether to send the milestone nudge. */
  endTurn(input: TurnInput): boolean {
    this.turn++;
    const { cfg } = this;
    const handoffBand = cfg.contextBands === false ? undefined : cfg.contextBands.handoff;
    if (handoffBand !== undefined && input.contextPercent >= handoffBand) {
      this.committed = false;
      return false;
    }
    if (!this.committed || this.turn - this.lastNudgeTurn < cfg.nudgeCooldownTurns)
      return false;
    this.lastNudgeTurn = this.turn;
    this.committed = false;
    return true;
  }
}
