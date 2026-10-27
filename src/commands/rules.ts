import { resolveProjectScope } from "../flows/scope.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  appendManaged,
  oneLine,
  readManaged,
  replaceManaged,
  RULE_HEADING,
  type RuleKind,
} from "../store.ts";
import { pickRuleTarget, rejectSecret } from "./shared.ts";

export function registerRememberCommand(rt: Runtime): void {
  rt.pi.registerCommand("nb:remember", {
    description: "Save a preference or project convention without the model",
    handler: async (args, ctx) => {
      const input =
        args.trim() ||
        (await ctx.ui.input("◆ Remember", "e.g. use pnpm, not npm"))?.trim();
      if (!input) return;
      if (rejectSecret(ctx, input)) return;

      const { project, global } = locate(ctx.cwd);
      let file = global.agentsFile;
      let kind: RuleKind = "preference";
      if (project) {
        const target = await pickRuleTarget(
          ctx,
          "◆ Remember as",
          "Preference (everywhere)",
          `Convention (${project.name} only)`,
        );
        if (!target) return;
        if (target === "project") {
          const r = await resolveProjectScope(
            ctx,
            project,
            rt.session.cfg.storage,
          );
          if (!("scope" in r)) return;
          file = r.scope.agentsFile;
          kind = "convention";
        }
      }
      appendManaged(file, RULE_HEADING[kind], input);
      rt.session.invalidate();
      ctx.ui.notify(`✓ Saved ${kind}: ${oneLine(input)}`, "info");
      rt.refreshStatus(ctx);
    },
  });
}

export function registerPrefsCommand(rt: Runtime): void {
  rt.pi.registerCommand("nb:prefs", {
    description: "Edit saved preferences or project conventions by hand",
    handler: async (_args, ctx) => {
      const { project, scope, global } = locate(ctx.cwd);
      let file = global.agentsFile;
      let kind: RuleKind = "preference";
      if (scope && project) {
        const target = await pickRuleTarget(
          ctx,
          "◆ Edit",
          "Preferences (everywhere)",
          `Conventions (${project.name})`,
        );
        if (!target) return;
        if (target === "project") {
          file = scope.agentsFile;
          kind = "convention";
        }
      }
      const heading = RULE_HEADING[kind];
      const noun = heading.slice(3);
      const edited = await ctx.ui.editor(
        `◆ ${noun}, one per line`,
        readManaged(file).join("\n"),
      );
      if (edited === undefined) return;
      const lines = edited
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
      if (rejectSecret(ctx, lines.join("\n"))) return;
      replaceManaged(file, heading, lines);
      rt.session.invalidate();
      ctx.ui.notify(`✓ Saved ${lines.length} ${noun.toLowerCase()}`, "info");
      rt.refreshStatus(ctx);
    },
  });
}
