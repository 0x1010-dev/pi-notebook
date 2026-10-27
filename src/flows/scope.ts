import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  existingProjectScope,
  type Project,
  projectScope,
  type Scope,
  type StorageMode,
} from "../paths.ts";
import { loadState, saveState } from "../state.ts";
import { initScope } from "../store.ts";

export type Resolution = { scope: Scope } | { cancelled: true };

/** Storage modes ordered with the configured default first. */
export function storageModes(preferred: StorageMode): StorageMode[] {
  return preferred === "repo" ? ["repo", "local"] : ["local", "repo"];
}

const NEVER = "Never ask for this repo";

const MODE_LABEL: Record<StorageMode, string> = {
  repo: "Create notebook in repo (.pi/notebook)",
  local: "Create notebook locally (~/.pi/agent/pi-notebook)",
};

/** Existing project notebook, or one the user agrees to create. */
export async function resolveProjectScope(
  ctx: ExtensionContext,
  project: Project,
  preferred: StorageMode,
): Promise<Resolution> {
  const existing = existingProjectScope(project);
  if (existing) return { scope: existing };
  const state = loadState();
  if (state.declined.includes(project.root) || !ctx.hasUI)
    return { cancelled: true };

  const modes = storageModes(preferred);
  const choice = await ctx.ui.select(`◆ No notebook for ${project.name} yet`, [
    ...modes.map((m) => MODE_LABEL[m]),
    "Not now",
    NEVER,
  ]);

  const mode = modes.find((m) => MODE_LABEL[m] === choice);
  if (mode) {
    const scope = projectScope(project, mode);
    initScope(scope);
    return { scope };
  }
  if (choice === NEVER) {
    state.declined.push(project.root);
    saveState(state);
  }
  return { cancelled: true };
}
