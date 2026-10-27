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
import { listAll, readHandoff } from "./store.ts";
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

export function statusInfo(located: Located, session: Session): StatusInfo {
  const { project, scope, global } = located;
  return {
    project,
    scope,
    projectEntries: scope ? listAll(scope) : [],
    globalEntries: listAll(global),
    handoff: scope ? readHandoff(scope) : undefined,
    hint: session.hint,
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
    const info = statusInfo(locate(ctx.cwd), session);
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
        render: (width: number) => [truncateToWidth(statusLine(theme, info), width)],
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
      session.setHint(undefined);
      if (ctx.isIdle()) pi.sendUserMessage(prompt);
      else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
      refreshStatus(ctx);
    },
  };
}
