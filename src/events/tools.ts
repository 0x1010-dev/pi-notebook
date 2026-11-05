import { join } from "node:path";
import { guardToolCall, managedWriteChanged, MANAGED_WARNING } from "../guard.ts";
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
    if (verdict?.action === "verify")
      session.managedWrites.set(event.toolCallId, verdict.snapshot);
  });

  pi.on("tool_result", async (event, ctx) => {
    const snapshot = session.managedWrites.get(event.toolCallId);
    session.managedWrites.delete(event.toolCallId);
    session.recordToolResult(
      event.toolName,
      event.input.command,
      event.isError,
    );

    if (snapshot && !event.isError && managedWriteChanged(snapshot)) {
      if (ctx.hasUI)
        ctx.ui.notify(
          MANAGED_WARNING,
          "warning",
        );
      return {
        content: [...event.content, { type: "text", text: MANAGED_WARNING }],
        structuredContent: event.structuredContent,
      };
    }
  });
}
