import { NUDGE_TYPE } from "../constants.ts";
import { locate, type Runtime } from "../runtime.ts";
import { nudgeText } from "../signals.ts";
import { readHandoff } from "../store.ts";

export function registerTurnEvents({ pi, session, refreshStatus }: Runtime): void {
  pi.on("turn_end", async (event, ctx) => {
    const { scope } = locate(ctx.cwd);
    const kind = session.endTurn({
      contextPercent: ctx.getContextUsage()?.percent ?? 0,
      handoffMissing: !!scope && !readHandoff(scope),
    });
    refreshStatus(ctx);
    if (!kind || !session.cfg.nudgeModel) return;
    // A final turn has no next request in this run, so defer to the next prompt.
    if (event.toolResults.length === 0) {
      session.pendingNudge = kind;
      return;
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: NUDGE_TYPE,
          content: nudgeText(kind),
          display: false,
        },
      ],
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshStatus(ctx);
  });
}
