import { NUDGE_TYPE } from "../constants.ts";
import { locate, type Runtime } from "../runtime.ts";
import type { Scope } from "../paths.ts";
import { nudgeText } from "../signals.ts";
import { loadState } from "../state.ts";
import { listAll, readHandoff } from "../store.ts";

/** Entries added since each scope was last curated. */
function uncuratedCount(scopes: (Scope | undefined)[]): number {
  const { curated } = loadState();
  return scopes
    .filter((s): s is Scope => !!s)
    .reduce(
      (n, s) => n + Math.max(0, listAll(s).length - (curated[s.dir] ?? 0)),
      0,
    );
}

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
    session.ageHint();
    if (!session.hint) {
      const { scope, global } = locate(ctx.cwd);
      const fresh = uncuratedCount([scope, global]);
      if (fresh >= session.cfg.curateAfter)
        session.setHint({
          command: "/nb:curate",
          reason: `to tidy ${fresh} entries`,
        });
    }
    refreshStatus(ctx);
  });
}
