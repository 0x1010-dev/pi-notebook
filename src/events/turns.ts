import { NUDGE_TYPE } from "../constants.ts";
import { type Runtime } from "../runtime.ts";
import { MILESTONE_NUDGE } from "../signals.ts";

export function registerTurnEvents({
  pi,
  session,
  refreshStatus,
}: Runtime): void {
  pi.on("turn_end", async (event, ctx) => {
    const nudge = session.endTurn({
      contextPercent: ctx.getContextUsage()?.percent ?? 0,
    });
    refreshStatus(ctx);
    if (!nudge || !session.cfg.nudgeModel) return;
    // A final turn has no next request in this run, so defer to the next prompt.
    if (event.toolResults.length === 0) {
      session.pendingNudge = true;
      return;
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: NUDGE_TYPE,
          content: MILESTONE_NUDGE,
          display: false,
        },
      ],
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshStatus(ctx);
  });
}
