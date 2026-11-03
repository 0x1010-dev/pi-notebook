import { buildSection, estimateTokens } from "../inject.ts";
import { locate, type Runtime, statusInfo } from "../runtime.ts";
import { readManaged } from "../store.ts";
import { NotebookView, type ViewData } from "../view.ts";

export function registerShowCommand({ pi, session }: Runtime): void {
  pi.registerCommand("nb", {
    description: "Show the notebook",
    handler: async (_args, ctx) => {
      const located = locate(ctx.cwd);
      const { project, scope, global } = located;
      const snapshot = statusInfo(located);
      const data: ViewData = {
        ...snapshot,
        preferences: readManaged(global.agentsFile),
        injectedTokens: estimateTokens(
          buildSection({
            project,
            scope,
            global,
            budgetTokens: session.cfg.injectBudgetTokens,
            globalLimit: session.cfg.globalIndexLimit,
            snapshot,
          }),
        ),
      };
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          `notebook: ${data.projectEntries.length} project entries, ${data.globalEntries.length} global entries`,
          "info",
        );
        return;
      }
      let view: NotebookView | undefined;
      try {
        await ctx.ui.custom<void>(
          (tui, theme, _kb, done) =>
            (view = new NotebookView(data, theme, tui, () => done())),
        );
      } finally {
        view?.dispose();
      }
    },
  });
}
