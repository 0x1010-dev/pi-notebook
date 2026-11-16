import { Type } from "typebox";
import { formatHandoff } from "../inject.ts";
import { locate, type Runtime } from "../runtime.ts";
import { oneLine, writeHandoff } from "../store.ts";
import { findSecret, secretError } from "../validate.ts";
import { callRow, text, textRow } from "./shared.ts";

export function registerHandoffUpdate(rt: Runtime): void {
  rt.pi.registerTool({
    name: "handoff_update",
    label: "Notebook",
    description:
      "Project notebooks only. Replace the project's handoff with one consistent snapshot of unfinished work at a milestone or wrap-up. Include the current goal, status and all remaining next actions. Clear completed work; do not write a session log. Omitted blockers and notes are cleared, not retained. Never use global memory to store session progress. Read the current handoff first if you need it.",
    promptSnippet:
      "handoff_update: update a project handoff; unavailable without a project notebook",
    parameters: Type.Object({
      goal: Type.String({ description: "Current goal, one line." }),
      status: Type.String({
        description: "Where things actually stand, briefly.",
      }),
      next_steps: Type.Array(Type.String(), {
        description:
          "All remaining concrete actions, in order; [] when complete.",
      }),
      blockers: Type.Optional(
        Type.Array(Type.String(), {
          description: "Current blockers; omitted means none.",
        }),
      ),
      notes: Type.Optional(
        Type.String({
          description:
            "Other essential resumption context; omitted means none.",
        }),
      ),
    }),
    executionMode: "sequential",
    async execute(_id, args, _signal, _onUpdate, ctx) {
      const { project, scope } = locate(ctx.cwd);
      if (!project) {
        throw new Error(
          "No project detected. Handoffs are project-scoped; do not save session progress to the global notebook.",
        );
      }
      if (!scope) {
        throw new Error(
          "No project notebook. Run /nb:init before saving a handoff.",
        );
      }
      if (!args.goal.trim() || !args.status.trim()) {
        throw new Error("A handoff needs a nonblank goal and status.");
      }
      const secret = findSecret(
        [
          args.goal,
          args.status,
          ...args.next_steps,
          ...(args.blockers ?? []),
          args.notes ?? "",
        ].join("\n"),
      );
      if (secret) {
        throw new Error(secretError(secret));
      }
      const saved = {
        goal: oneLine(args.goal),
        status: args.status.trim(),
        nextSteps: args.next_steps.map(oneLine).filter(Boolean),
        blockers: (args.blockers ?? []).map(oneLine).filter(Boolean),
        notes: args.notes?.trim() ?? "",
        updated: new Date().toISOString(),
      };
      writeHandoff(scope, saved);
      rt.session.markHandoff();
      rt.refreshStatus(ctx);
      return {
        content: text(`Handoff replaced:\n\n${formatHandoff(saved)}`),
        details: { goal: saved.goal },
      };
    },
    renderCall(args, theme) {
      return callRow(theme, "handoff", theme.fg("dim", args.goal ?? ""));
    },
    renderResult(result, _opts, theme) {
      const details = result.details as { goal?: string } | undefined;
      return textRow(theme.fg("muted", details?.goal ?? "not saved"));
    },
  });
}
