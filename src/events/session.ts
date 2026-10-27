import { locate, type Runtime } from "../runtime.ts";
import { listAll, readHandoff } from "../store.ts";
import { startupSummary } from "../view.ts";

export function registerSessionEvents({ pi, session, refreshStatus }: Runtime): void {
  pi.on("session_start", async (event, ctx) => {
    session.reset();
    refreshStatus(ctx);

    if (!ctx.hasUI || (event.reason !== "startup" && event.reason !== "new"))
      return;
    const { project, scope } = locate(ctx.cwd);
    if (!project || !scope) return;
    const summary = startupSummary({
      project,
      scope,
      handoff: readHandoff(scope),
      entries: listAll(scope),
    });
    if (summary) ctx.ui.notify(summary, "info");
  });

  pi.on("session_compact", async (_event, ctx) => {
    session.onCompact();
    refreshStatus(ctx);
  });
}
