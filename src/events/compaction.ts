import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NUDGE_TYPE } from "../constants.ts";
import { formatHandoff } from "../inject.ts";
import { locate, type Runtime } from "../runtime.ts";
import { readHandoff, type Handoff } from "../store.ts";

function currentHandoff(ctx: ExtensionContext): Handoff | undefined {
  const { scope } = locate(ctx.cwd);
  return scope && readHandoff(scope);
}

export function registerCompactionEvents({ pi, session }: Runtime): void {
  pi.on("session_before_compact", async (event, ctx) => {
    const { cfg } = session;
    if (!cfg.handoffCompaction) return;
    const handoff = currentHandoff(ctx);
    if (!handoff) return;
    const fresh = session.handoffFresh();
    const summary = `[pi-notebook] Earlier conversation was replaced by the project handoff${
      fresh ? "" : " (may be out of date; recent messages follow)"
    }.\n\n${formatHandoff(handoff)}`;
    session.handoffCompacted = true;
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });

  function resume(ctx: ExtensionContext): void {
    if (!session.resumePending) return;
    session.resumePending = false;
    const { cfg } = session;
    const handoff = currentHandoff(ctx);
    if (!handoff || handoff.nextSteps.length === 0) return;
    if (session.compactCycles >= cfg.maxCompactCycles) {
      if (ctx.hasUI)
        ctx.ui.notify(
          `pi-notebook: auto-continue stopped after ${cfg.maxCompactCycles} compactions.`,
          "warning",
        );
      return;
    }
    session.compactCycles++;
    pi.sendMessage(
      {
        customType: NUDGE_TYPE,
        content: "[pi-notebook] Context was compacted. Continue the work from the handoff.",
        display: false,
      },
      { triggerTurn: true },
    );
  }

  pi.on("agent_settled", async (event, ctx) => {
    if (event.aborted) {
      session.compactPending = false;
      session.resumePending = false;
      return;
    }
    if (session.compactPending) {
      ctx.compact({
        onComplete: () => resume(ctx),
        onError: (e) => {
          session.compactPending = false;
          if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${e.message}`, "error");
        },
      });
      return;
    }
    if (session.resumePending) resume(ctx);
  });
}
