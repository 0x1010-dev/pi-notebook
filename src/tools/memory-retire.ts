import { Type } from "typebox";
import { retireRefs } from "../flows/retire.ts";
import type { Runtime } from "../runtime.ts";
import { callRow, splitListArgs, text, textRow } from "./shared.ts";

export function registerMemoryRetire(rt: Runtime): void {
  rt.pi.registerTool({
    name: "memory_retire",
    label: "Notebook",
    description:
      "Archive memories that no longer apply. To correct knowledge, update the existing memory with memory_save instead. Archived memories stay readable by ref but leave ordinary search and recall. The user confirms each retirement.",
    promptSnippet:
      "memory_retire: archive obsolete memories (user confirms)",
    parameters: Type.Object({
      refs: Type.Array(Type.String(), {
        description:
          'Refs to archive, for example ["M3", "~M1"].',
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
          "Retiring entries needs user confirmation, which is unavailable in this mode.",
        );
      const r = await retireRefs(rt, ctx, p.refs, p.reason);
      return {
        content: text(r.message),
        details: { retired: r.retired, declined: r.declined },
      };
    },

    renderCall(args, theme) {
      return callRow(
        theme,
        "retire",
        theme.fg("accent", (args.refs ?? []).join(" ")),
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as
        | { retired: string[]; declined: boolean }
        | undefined;
      if (d?.declined) return textRow(theme.fg("warning", "✗ declined"));
      if (!d?.retired.length)
        return textRow(theme.fg("dim", "nothing retired"));
      return textRow(
        `${theme.fg("success", "✓ ")}${theme.fg("muted", "retired")} ${theme.fg("accent", d.retired.join(" "))}`,
      );
    },
  });
}
