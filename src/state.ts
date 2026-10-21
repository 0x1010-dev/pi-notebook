import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { notebookHome } from "./paths.ts";

export interface PersistentState {
  /** Project roots where the user chose "never ask". */
  declined: string[];
  /** Entry count per scope dir at the last /nb:curate. */
  curated: Record<string, number>;
}

function statePath(): string {
  return join(notebookHome(), "state.json");
}

export function loadState(): PersistentState {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8"));
    return {
      declined: Array.isArray(raw.declined) ? raw.declined : [],
      curated:
        raw.curated && typeof raw.curated === "object" ? raw.curated : {},
    };
  } catch {
    return { declined: [], curated: {} };
  }
}

export function saveState(state: PersistentState): void {
  const home = notebookHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  writeFileSync(statePath(), `${JSON.stringify(state, null, 2)}\n`);
}
