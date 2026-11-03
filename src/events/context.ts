import { NUDGE_TYPE } from "../constants.ts";
import { locate, type Runtime } from "../runtime.ts";
import { bandIndex, bandText } from "../signals.ts";

/** Hidden, ephemeral one-line context-usage notes appended to the LLM request. */
export function registerContextEvents({ pi, session }: Runtime): void {
  pi.on("context", async (event, ctx) => {
    const { cfg } = session;
    if (!cfg.nudgeModel || cfg.contextBands.length === 0) return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null) return;
    const i = bandIndex(percent, cfg.contextBands);
    if (i < 0) return;
    const handoff = !!locate(ctx.cwd).scope;
    const compactTool = cfg.handoffCompaction && handoff;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: NUDGE_TYPE,
          content: bandText(percent, i, { handoff, compactTool }),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
