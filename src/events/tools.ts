import { join } from "node:path";
import { guardToolCall } from "../guard.ts";
import { notebookHome } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";

export function registerToolEvents({ pi, session }: Runtime): void {
  pi.on("tool_call", async (event, ctx) => {
    if (!session.cfg.guard) return;
    const { project, scope, global } = locate(ctx.cwd);
    const agentsFiles = [global.agentsFile];
    if (scope) agentsFiles.push(scope.agentsFile);
    else if (project) agentsFiles.push(join(project.root, "AGENTS.md"));
    const verdict = guardToolCall({
      toolName: event.toolName,
      input: event.input as Record<string, unknown>,
      cwd: ctx.cwd,
      roots: [notebookHome()],
      agentsFiles,
    });
    if (verdict?.action === "block")
      return { block: true, reason: verdict.reason };
    if (verdict?.action === "warn")
      session.warnings.set(event.toolCallId, verdict.reason);
  });

  pi.on("tool_result", async (event, ctx) => {
    const warning = session.warnings.get(event.toolCallId);
    session.warnings.delete(event.toolCallId);
    session.recordToolResult(event.toolName, event.input.command, event.isError);

    if (warning && !event.isError) {
      if (ctx.hasUI)
        ctx.ui.notify(
          "◆ The model changed the pi-notebook section of AGENTS.md",
          "warning",
        );
      return {
        content: [...event.content, { type: "text", text: warning }],
        structuredContent: event.structuredContent,
      };
    }
  });
}
