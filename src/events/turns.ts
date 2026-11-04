import { NUDGE_TYPE } from "../constants.ts";
import { locate, type Runtime } from "../runtime.ts";
import { bandText, MILESTONE_NUDGE } from "../signals.ts";

export function registerTurnEvents({
  pi,
  session,
  refreshStatus,
}: Runtime): void {
  pi.on("turn_end", async (event, ctx) => {
    const percent = ctx.getContextUsage()?.percent ?? 0;
    const milestone = session.endTurn({ contextPercent: percent });
    const band = session.crossBand(percent);
    refreshStatus(ctx);
    const { cfg } = session;
    if (!cfg.nudgeModel) return;
    const notes: string[] = [];
    if (band !== undefined) {
      const handoff = !!locate(ctx.cwd).scope;
      notes.push(bandText(percent, band, { handoff, compactTool: cfg.handoffCompaction && handoff }));
    }
    if (milestone) notes.push(MILESTONE_NUDGE);
    if (!notes.length) return;
    const content = notes.join("\n\n");
    // A final turn has no next request in this run, so defer to the next prompt.
    if (event.toolResults.length === 0) {
      session.pendingNudge = content;
      return;
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: NUDGE_TYPE,
          content,
          display: false,
        },
      ],
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    refreshStatus(ctx);
  });
}
