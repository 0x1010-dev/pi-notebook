import { Type } from "typebox";
import { locate, type Runtime } from "../runtime.ts";
import { callRow, text, textRow } from "./shared.ts";

export function registerContextCompact(rt: Runtime): void {
  rt.pi.registerTool({
    name: "context_compact",
    label: "Notebook",
    description:
      "Compact the conversation once the handoff is current. The handoff replaces earlier context, so update it first with handoff_update. Compaction runs after this response ends; work resumes from the handoff.",
    promptSnippet: "context_compact: compact the conversation after updating the handoff",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _p, _signal, _onUpdate, ctx) {
      const { scope } = locate(ctx.cwd);
      if (!scope) throw new Error("No project notebook. Run /nb:init first.");
      if (!rt.session.handoffFresh())
        throw new Error("Update the handoff with handoff_update first, then call context_compact.");
      rt.session.compactPending = true;
      return {
        content: text("Compaction scheduled. End your response now; work resumes from the handoff."),
        details: {},
      };
    },
    renderCall(_args, theme) {
      return callRow(theme, "compact", "");
    },
    renderResult(_result, _opts, theme) {
      return textRow(theme.fg("muted", "scheduled"));
    },
  });
}
