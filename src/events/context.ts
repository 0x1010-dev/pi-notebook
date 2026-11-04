import { NUDGE_TYPE } from "../constants.ts";
import { type Runtime } from "../runtime.ts";
import { usageText } from "../signals.ts";

/** Bare usage line on each request past the compaction band; band suggestions are sent once from turn_end. */
export function registerContextEvents({ pi, session }: Runtime): void {
  pi.on("context", async (event, ctx) => {
    const { cfg } = session;
    const from = cfg.contextBands === false ? undefined : cfg.contextBands.compact;
    if (!cfg.nudgeModel || from === undefined) return;
    const percent = ctx.getContextUsage()?.percent;
    if (percent == null || percent < from) return;
    return {
      messages: [
        ...event.messages,
        {
          role: "custom",
          customType: NUDGE_TYPE,
          content: usageText(percent),
          display: false,
          timestamp: Date.now(),
        },
      ],
    };
  });
}
