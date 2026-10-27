import { locate, type Runtime } from "../runtime.ts";
import { readHandoff } from "../store.ts";

export function registerSessionEvents({ pi, session, refreshStatus }: Runtime): void {
  pi.on("session_start", async (event, ctx) => {
    session.reset();
    refreshStatus(ctx);

    if (!ctx.hasUI || (event.reason !== "startup" && event.reason !== "new"))
      return;
    const { project, scope } = locate(ctx.cwd);
    const h = scope ? readHandoff(scope) : undefined;
    if (project && h?.goal) {
      const next = h.nextSteps[0] ? `  ›  ${h.nextSteps[0]}` : "";
      ctx.ui.notify(`◆ ${project.name}: ${h.goal}${next}`, "info");
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    session.onCompact();
    refreshStatus(ctx);
  });
}
