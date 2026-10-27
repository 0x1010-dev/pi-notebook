import { storageModes } from "../flows/scope.ts";
import {
  existingProjectScope,
  findProject,
  projectScope,
  type StorageMode,
} from "../paths.ts";
import type { Runtime } from "../runtime.ts";
import { loadState, saveState } from "../state.ts";
import { initScope } from "../store.ts";

const MODE_LABEL: Record<StorageMode, string> = {
  repo: "In repo (.pi/notebook, commit it)",
  local: "Local (~/.pi/agent/pi-notebook)",
};

export function registerInitCommand(rt: Runtime): void {
  rt.pi.registerCommand("nb:init", {
    description: "Create a notebook for this project (repo or local)",
    getArgumentCompletions: (prefix) =>
      (["repo", "local"] as const)
        .filter((m) => m.startsWith(prefix.trim()))
        .map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      const project = findProject(ctx.cwd);
      if (!project) {
        ctx.ui.notify("Not inside a git repository.", "warning");
        return;
      }
      const existing = existingProjectScope(project);
      if (existing) {
        ctx.ui.notify(`Notebook already exists at ${existing.dir}`, "info");
        return;
      }
      const arg = args.trim();
      let mode: StorageMode | undefined =
        arg === "repo" || arg === "local" ? arg : undefined;
      if (!mode) {
        const modes = storageModes(rt.session.cfg.storage);
        const labels = modes.map((m) => MODE_LABEL[m]);
        const choice = await ctx.ui.select(
          `◆ Create notebook for ${project.name}`,
          labels,
        );
        mode = modes[labels.indexOf(choice ?? "")];
      }
      if (!mode) return;
      const scope = projectScope(project, mode);
      initScope(scope);
      const state = loadState();
      if (state.declined.includes(project.root)) {
        state.declined = state.declined.filter((r) => r !== project.root);
        saveState(state);
      }
      rt.session.clearHintIf("/nb:init");
      rt.session.invalidate();
      ctx.ui.notify(`◆ Notebook created at ${scope.dir}`, "info");
      rt.refreshStatus(ctx);
    },
  });
}
