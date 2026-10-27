import { Type } from "typebox";
import { formatHandoff } from "../inject.ts";
import { locate, type Runtime } from "../runtime.ts";
import { type Handoff, oneLine, readHandoff, writeHandoff } from "../store.ts";
import { findSecret, secretError } from "../validate.ts";
import { callRow, text, textRow } from "./shared.ts";

export function registerHandoffUpdate(rt: Runtime): void {
  rt.pi.registerTool({
    name: "handoff_update",
    label: "Notebook",
    description:
      "Update this project's cross-session handoff: what we are doing, where it stands, what comes next. Call it after agreeing on a plan, after finishing a piece of work, and whenever the work state changes, so a later session can resume. Fields you leave out keep their current value; pass an empty list or string to clear one. goal is required when there is no handoff yet.",
    promptSnippet:
      "handoff_update: record current goal, status and next steps for the next session",
    parameters: Type.Object({
      goal: Type.Optional(
        Type.String({
          description: "The overall goal of the current work, one line.",
        }),
      ),
      status: Type.Optional(
        Type.String({
          description: "Where things stand now, one or two sentences.",
        }),
      ),
      next_steps: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Concrete next actions, in order, including any unfinished todos. Replaces the whole list; include items that are still open.",
        }),
      ),
      blockers: Type.Optional(
        Type.Array(Type.String(), {
          description: "Open problems or questions. Replaces the whole list; include items that are still open.",
        }),
      ),
      notes: Type.Optional(
        Type.String({
          description: "Anything else a fresh session must know.",
        }),
      ),
    }),
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const { project, scope } = locate(ctx.cwd);
      if (!project)
        return {
          content: text("Not inside a project; no handoff needed."),
          details: undefined,
        };
      if (!scope) {
        return {
          content: text(
            "This project has no notebook, so the handoff was not saved. Do not retry. The user can run /nb:init.",
          ),
          details: undefined,
        };
      }
      const prev = readHandoff(scope);
      const goal = p.goal ?? prev?.goal ?? "";
      if (!goal.trim())
        throw new Error("This project has no handoff yet, so goal is required.");
      const secret = findSecret(
        [
          p.goal ?? "",
          p.status ?? "",
          ...(p.next_steps ?? []),
          ...(p.blockers ?? []),
          p.notes ?? "",
        ].join("\n"),
      );
      if (secret) throw new Error(secretError(secret));
      const saved: Handoff = {
        goal: oneLine(goal),
        status: (p.status ?? prev?.status ?? "").trim(),
        nextSteps: p.next_steps ?? prev?.nextSteps ?? [],
        blockers: p.blockers ?? prev?.blockers ?? [],
        notes: p.notes ?? prev?.notes ?? "",
        updated: new Date().toISOString(),
      };
      writeHandoff(scope, saved);
      rt.markSaved(ctx);
      const shrink = (label: string, before: number, after: number) =>
        before - after >= 3
          ? `Warning: ${label} went from ${before} to ${after} items. The list is replaced, not merged; if items were dropped by mistake, call again with the full list.`
          : undefined;
      const warnings = [
        p.next_steps
          ? shrink(
              "next_steps",
              prev?.nextSteps.length ?? 0,
              saved.nextSteps.length,
            )
          : undefined,
        p.blockers
          ? shrink("blockers", prev?.blockers.length ?? 0, saved.blockers.length)
          : undefined,
      ].filter(Boolean);
      return {
        content: text(
          [`Handoff saved:\n\n${formatHandoff(saved)}`, ...warnings].join(
            "\n\n",
          ),
        ),
        details: { goal: saved.goal, next: saved.nextSteps.length },
      };
    },

    renderCall(args, theme) {
      return callRow(theme, "handoff", theme.fg("dim", args.goal ?? ""));
    },

    renderResult(result, _opts, theme) {
      const d = result.details as { goal: string; next: number } | undefined;
      if (!d) return textRow(theme.fg("dim", "skipped"));
      return textRow(
        `${theme.fg("success", "✓ ")}${theme.fg("muted", "handoff")} ${theme.fg("dim", `· ${d.next} next steps`)}`,
      );
    },
  });
}
