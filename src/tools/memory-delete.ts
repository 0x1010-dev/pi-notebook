import { Type } from "typebox";
import { deleteRefs } from "../flows/delete.ts";
import type { Runtime } from "../runtime.ts";
import { callRow, splitListArgs, text, textRow } from "./shared.ts";

export function registerMemoryDelete(rt: Runtime): void {
  rt.pi.registerTool({
    name: "memory_delete",
    label: "Notebook",
    description:
      "Permanently delete memories that no longer apply. No archive or notebook undo is kept. To correct knowledge, update its existing memory with memory_save instead. Preserve still-current knowledge before deleting a mixed-topic memory. The user must confirm deletion.",
    promptSnippet:
      "memory_delete: permanently remove obsolete memories (user confirms)",
    parameters: Type.Object({
      refs: Type.Array(Type.String(), {
        description:
          'Refs to delete, for example ["M3", "~M1"].',
      }),
      reason: Type.String({
        description: "Why they no longer apply, one line.",
      }),
    }),
    prepareArguments: (args) => splitListArgs(args, ["refs"]),
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI)
        throw new Error(
          "Deleting memories needs user confirmation, which is unavailable in this mode.",
        );
      const r = await deleteRefs(rt, ctx, p.refs, p.reason);
      return {
        content: text(r.message),
        details: { deleted: r.deleted, declined: r.declined },
      };
    },

    renderCall(args, theme) {
      return callRow(
        theme,
        "delete",
        theme.fg("accent", (args.refs ?? []).join(" ")),
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as
        | { deleted: string[]; declined: boolean }
        | undefined;
      if (d?.declined) return textRow(theme.fg("warning", "✗ declined"));
      if (!d?.deleted.length)
        return textRow(theme.fg("dim", "nothing deleted"));
      return textRow(
        `${theme.fg("success", "✓ ")}${theme.fg("muted", "deleted")} ${theme.fg("accent", d.deleted.join(" "))}`,
      );
    },
  });
}
