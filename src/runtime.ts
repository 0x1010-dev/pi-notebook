import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_KEY } from "./constants.ts";
import {
  existingProjectScope,
  findProject,
  globalScope,
  type Project,
  type Scope,
} from "./paths.ts";
import { Session } from "./session.ts";
import { loadNotebook } from "./context-files.ts";
import { diagnosticText } from "./store.ts";
import { type StatusInfo, statusLine } from "./ui.ts";

export interface Located {
  project: Project | undefined;
  /** Existing project notebook, if any. */
  scope: Scope | undefined;
  global: Scope;
}

export function locate(cwd: string): Located {
  const project = findProject(cwd);
  return {
    project,
    scope: project ? existingProjectScope(project) : undefined,
    global: globalScope(),
  };
}

export function statusInfo(located: Located): StatusInfo & ReturnType<typeof loadNotebook> {
  const { project, scope } = located;
  return {
    project,
    scope,
    ...loadNotebook(located),
  };
}

/** Shared handle passed to every event, tool and command module. */
export interface Runtime {
  pi: ExtensionAPI;
  session: Session;
  refreshStatus(ctx: ExtensionContext): void;
  /** Record that something durable was saved and update the status line. */
  markSaved(ctx: ExtensionContext): void;
  /** Send a prompt written by this extension without it triggering a nudge. */
  sendOwnPrompt(ctx: ExtensionContext, prompt: string): void;
}

export function createRuntime(pi: ExtensionAPI): Runtime {
  const session = new Session();

  const refreshStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const info = statusInfo(locate(ctx.cwd));
    const diagnostics = diagnosticText(info.diagnostics ?? []);
    if (session.loadWarning !== diagnostics) {
      session.loadWarning = diagnostics;
      if (diagnostics) ctx.ui.notify(diagnostics, "warning");
    }
    const placement = session.cfg.statusPlacement;
    if (placement === "footer") {
      ctx.ui.setWidget(STATUS_KEY, undefined);
      ctx.ui.setStatus(STATUS_KEY, statusLine(ctx.ui.theme, info));
      return;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    // Re-registering moves the row last, i.e. between other widgets (like todos) and the editor.
    ctx.ui.setWidget(
      STATUS_KEY,
      (_tui, theme) => ({
        render: (width: number) => [
          truncateToWidth(statusLine(theme, info), width),
        ],
        invalidate: () => {},
      }),
      { placement },
    );
  };

  return {
    pi,
    session,
    refreshStatus,
    markSaved(ctx) {
      session.markSaved();
      refreshStatus(ctx);
    },
    sendOwnPrompt(ctx, prompt) {
      session.suppressNudgeOnce = true;
      session.invalidate();
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      refreshStatus(ctx);
    },
  };
}
