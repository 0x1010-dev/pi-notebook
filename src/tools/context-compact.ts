import { Type } from "typebox";
import { locate, type Runtime } from "../runtime.ts";
import { callRow, text, textRow } from "./shared.ts";

export function registerContextCompact(rt: Runtime): void {
  rt.pi.registerTool({
    name: "context_compact",
    label: "Notebook",
    description:
      "Project notebooks only. Compact the conversation once the project handoff is current. The handoff replaces earlier context, so update it first with handoff_update. Compaction runs after this response ends; work resumes from the handoff. Never store session progress in the global notebook.",
    promptSnippet: "context_compact: compact after updating a project handoff; unavailable without a project notebook",
    parameters: Type.Object({}),
    executionMode: "sequential",
    async execute(_id, _p, _signal, _onUpdate, ctx) {
      const { project, scope } = locate(ctx.cwd);
      if (!project)
        throw new Error("No project detected. Compaction needs a project handoff; keep session progress in the conversation, not global memory.");
      if (!scope) throw new Error("No project notebook. Run /nb:init first.");
      const percent = ctx.getContextUsage()?.percent;
      if (percent == null)
        throw new Error("Context usage is unknown until the next response, usually because compaction just ran. Compaction is not needed; continue the work.");
      const bands = rt.session.cfg.contextBands;
      if (percent < (bands === false ? 0 : bands.save))
        throw new Error(`Context window is only ${Math.round(percent)}% full. Compaction is not needed; continue the work.`);
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
