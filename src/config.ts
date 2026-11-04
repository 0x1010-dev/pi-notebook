import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, type StorageMode } from "./paths.ts";

export interface ContextBands {
  save: number;
  handoff: number;
  compact: number;
}

export interface NotebookConfig {
  /** Default storage offered when initializing a project. */
  storage: StorageMode;
  /** Upper bound for the injected notebook section. */
  injectBudgetTokens: number;
  /** Most recent global entries listed in the injected index. */
  globalIndexLimit: number;
  /** Minimum turns between nudges. */
  nudgeCooldownTurns: number;
  /** Context usage percents with save < handoff < compact. false disables reminders. */
  contextBands: ContextBands | false;
  /** Send short hidden nudges to the model when signals fire. */
  nudgeModel: boolean;
  /** Block direct model file-tool writes to notebook files (not a shell security boundary). */
  guard: boolean;
  /** Cache the injected section until notebook content changes, or rebuild every turn. */
  refreshSection: "session" | "turn";
  /** Entries matching the user's prompt attached as a hidden note. 0 disables. */
  autoRecall: number;
  /** Where the status shows: shared footer status, or a row of its own near the editor. */
  statusPlacement: "footer" | "belowEditor" | "aboveEditor";
  /** Use the handoff as the compaction summary and offer context_compact. */
  handoffCompaction: boolean;
  /** Turns after which this session's handoff counts as stale. */
  handoffStaleTurns: number;
  /** Auto-continue cap per session. */
  maxCompactCycles: number;
}

export const DEFAULT_CONFIG: NotebookConfig = {
  storage: "repo",
  injectBudgetTokens: 1500,
  globalIndexLimit: 20,
  nudgeCooldownTurns: 16,
  contextBands: { save: 40, handoff: 55, compact: 70 },
  nudgeModel: true,
  guard: true,
  refreshSection: "session",
  autoRecall: 3,
  statusPlacement: "aboveEditor",
  handoffCompaction: true,
  handoffStaleTurns: 5,
  maxCompactCycles: 20,
};

/** Reads the "notebook" key of Pi's settings.json. */
export function loadConfig(): NotebookConfig {
  try {
    const settings = JSON.parse(
      readFileSync(join(agentDir(), "settings.json"), "utf8"),
    );
    const raw = settings?.notebook;
    if (!raw || typeof raw !== "object") return { ...DEFAULT_CONFIG };
    const cfg = { ...DEFAULT_CONFIG };
    if (raw.storage === "repo" || raw.storage === "local")
      cfg.storage = raw.storage;
    for (const key of [
      "injectBudgetTokens",
      "globalIndexLimit",
      "nudgeCooldownTurns",
      "handoffStaleTurns",
      "maxCompactCycles",
    ] as const) {
      if (typeof raw[key] === "number" && raw[key] >= 1) cfg[key] = Math.floor(raw[key]);
    }
    if (raw.contextBands === false) {
      cfg.contextBands = false;
    } else if (raw.contextBands && typeof raw.contextBands === "object" && !Array.isArray(raw.contextBands)) {
      const bands = raw.contextBands;
      const valid = [bands.save, bands.handoff, bands.compact].every(
        (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100,
      ) && bands.save < bands.handoff && bands.handoff < bands.compact;
      if (valid) cfg.contextBands = { save: bands.save, handoff: bands.handoff, compact: bands.compact };
    }
    if (typeof raw.nudgeModel === "boolean") cfg.nudgeModel = raw.nudgeModel;
    if (typeof raw.guard === "boolean") cfg.guard = raw.guard;
    if (typeof raw.handoffCompaction === "boolean")
      cfg.handoffCompaction = raw.handoffCompaction;
    if (["footer", "belowEditor", "aboveEditor"].includes(raw.statusPlacement))
      cfg.statusPlacement = raw.statusPlacement;
    if (raw.refreshSection === "session" || raw.refreshSection === "turn")
      cfg.refreshSection = raw.refreshSection;
    if (typeof raw.autoRecall === "number" && raw.autoRecall >= 0)
      cfg.autoRecall = Math.floor(raw.autoRecall);
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
