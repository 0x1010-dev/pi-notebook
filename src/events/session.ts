import { HANDOFF_FRESH_MS } from "../constants.ts";
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
    const { scope } = locate(ctx.cwd);
    const h = scope ? readHandoff(scope) : undefined;
    const fresh = h && Date.now() - Date.parse(h.updated) < HANDOFF_FRESH_MS;
    if (scope && !fresh)
      session.setHint({ command: "/nb:wrap", reason: "to save progress" });
    refreshStatus(ctx);
  });
}
