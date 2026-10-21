import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, type StorageMode } from "./paths.ts";

export interface NotebookConfig {
  /** Default storage offered when initializing a project. */
  storage: StorageMode;
  /** Upper bound for the injected notebook section. */
  injectBudgetTokens: number;
  /** Most recent global entries listed in the injected index. */
  globalIndexLimit: number;
  /** Agent runs without a save before suggesting /nb:wrap. */
  checkpointRuns: number;
  /** New entries since the last curate before suggesting /nb:curate. */
  curateAfter: number;
  /** Send short hidden nudges to the model when signals fire. */
  nudgeModel: boolean;
  /** Block file tools and shell commands that touch notebook files. */
  guard: boolean;
  /** Rebuild the injected section once per session (prompt-cache friendly) or every turn. */
  refreshSection: "session" | "turn";
  /** Entries matching the user's prompt attached as a hidden note. 0 disables. */
  autoRecall: number;
}

export const DEFAULT_CONFIG: NotebookConfig = {
  storage: "repo",
  injectBudgetTokens: 1500,
  globalIndexLimit: 20,
  checkpointRuns: 10,
  curateAfter: 10,
  nudgeModel: true,
  guard: true,
  refreshSection: "session",
  autoRecall: 3,
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
      "checkpointRuns",
      "curateAfter",
    ] as const) {
      if (typeof raw[key] === "number" && raw[key] > 0) cfg[key] = raw[key];
    }
    if (typeof raw.nudgeModel === "boolean") cfg.nudgeModel = raw.nudgeModel;
    if (typeof raw.guard === "boolean") cfg.guard = raw.guard;
    if (raw.refreshSection === "session" || raw.refreshSection === "turn")
      cfg.refreshSection = raw.refreshSection;
    if (typeof raw.autoRecall === "number" && raw.autoRecall >= 0)
      cfg.autoRecall = Math.floor(raw.autoRecall);
    return cfg;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
