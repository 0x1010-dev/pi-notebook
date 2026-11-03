import type { Scope } from "../paths.ts";
import { curatePrompt, wrapPrompt } from "../prompts.ts";
import { locate, type Runtime } from "../runtime.ts";
import { listAll } from "../store.ts";

/** Commands that hand the model a prompt instead of editing notes directly. */
export function registerPromptCommands(rt: Runtime): void {
  rt.pi.registerCommand("nb:wrap", {
    description:
      "Save worthwhile knowledge and reconcile the current handoff",
    handler: async (_args, ctx) => {
      const { scope } = locate(ctx.cwd);
      rt.sendOwnPrompt(ctx, wrapPrompt(!!scope));
    },
  });

  rt.pi.registerCommand("nb:curate", {
    description:
      "Reconcile current knowledge, verify claims and delete obsolete memories",
    handler: async (_args, ctx) => {
      const { scope, global } = locate(ctx.cwd);
      const scopes = [scope, global].filter((s): s is Scope => !!s);
      if (scopes.every((s) => listAll(s).length === 0)) {
        ctx.ui.notify("Nothing to curate yet.", "info");
        return;
      }
      rt.sendOwnPrompt(ctx, curatePrompt());
    },
  });
}
