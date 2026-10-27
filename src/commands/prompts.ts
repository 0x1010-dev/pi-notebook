import { join } from "node:path";
import { agentDir, findProject, type Scope } from "../paths.ts";
import { curatePrompt, learnPrompt, wrapPrompt } from "../prompts.ts";
import { locate, type Runtime } from "../runtime.ts";
import { loadState, saveState } from "../state.ts";
import { listAll } from "../store.ts";

/** Commands that hand the model a prompt instead of editing notes directly. */
export function registerPromptCommands(rt: Runtime): void {
  rt.pi.registerCommand("nb:learn", {
    description:
      "Ask the model to study this repo and record notes and conventions, e.g. /nb:learn or /nb:learn error handling",
    handler: async (args, ctx) => {
      if (!findProject(ctx.cwd)) {
        ctx.ui.notify("Not inside a git repository.", "warning");
        return;
      }
      rt.sendOwnPrompt(ctx, learnPrompt(args.trim()));
    },
  });

  rt.pi.registerCommand("nb:wrap", {
    description:
      "Ask the model to record decisions, lessons, notes and the handoff from this session",
    handler: async (_args, ctx) => {
      const { scope } = locate(ctx.cwd);
      rt.sendOwnPrompt(ctx, wrapPrompt(!!scope));
    },
  });

  rt.pi.registerCommand("nb:curate", {
    description:
      "Ask the model to merge duplicates, re-check outdated notes and retire stale notebook entries",
    handler: async (_args, ctx) => {
      const { project, scope, global } = locate(ctx.cwd);
      const scopes = [scope, global].filter((s): s is Scope => !!s);
      if (scopes.every((s) => listAll(s).length === 0)) {
        ctx.ui.notify("Nothing to curate yet.", "info");
        return;
      }
      const state = loadState();
      for (const s of scopes) state.curated[s.dir] = listAll(s).length;
      saveState(state);
      const skillDirs = [
        ...(project ? [join(project.root, ".pi", "skills")] : []),
        join(agentDir(), "skills"),
      ];
      rt.sendOwnPrompt(ctx, curatePrompt(skillDirs));
    },
  });
}
