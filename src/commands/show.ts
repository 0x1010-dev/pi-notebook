import { buildSection, estimateTokens } from "../inject.ts";
import { locate, type Runtime, statusInfo } from "../runtime.ts";
import { readManaged } from "../store.ts";
import { NotebookView, type ViewData } from "../ui.ts";

export function registerShowCommand({ pi, session }: Runtime): void {
  pi.registerCommand("nb", {
    description: "Show the notebook",
    handler: async (_args, ctx) => {
      const located = locate(ctx.cwd);
      const { project, scope, global } = located;
      const data: ViewData = {
        ...statusInfo(located, session),
        preferences: readManaged(global.agentsFile),
        conventions: scope ? readManaged(scope.agentsFile) : [],
        injectedTokens: estimateTokens(
          buildSection({
            project,
            scope,
            global,
            budgetTokens: session.cfg.injectBudgetTokens,
            globalLimit: session.cfg.globalIndexLimit,
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
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => new NotebookView(data, theme, () => done()),
      );
    },
  });
}
