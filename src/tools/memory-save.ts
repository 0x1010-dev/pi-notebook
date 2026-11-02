import { StringEnum } from "@earendil-works/pi-ai";
import { isAbsolute, relative, resolve } from "node:path";
import { Type } from "typebox";
import { CONFIRM_PREVIEW_CHARS } from "../constants.ts";
import { clip } from "../format.ts";
import { headCommit } from "../git.ts";
import { resolveProjectScope } from "../flows/scope.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  appendManaged, getEntry, oneLine, parseRef, ref, RULE_HEADING,
  saveEntry, searchEntries, updateEntry,
} from "../store.ts";
import { findSecret, secretError } from "../validate.ts";
import { callRow, splitListArgs, text, textRow } from "./shared.ts";

/** Project-relative paths; missing paths are useful too, but paths outside the project are not. */
export function normalizeMemoryFiles(files: string[], root: string): string[] {
  return [...new Set(files.map((file) => {
    const clean = file.trim();
    if (!clean) return "";
    const path = relative(root, resolve(root, clean));
    if (path === ".." || path.startsWith("../") || isAbsolute(path))
      throw new Error(`Related path is outside this project: ${file}`);
    return path || ".";
  }).filter(Boolean))];
}

export function registerMemorySave(rt: Runtime): void {
  rt.pi.registerTool({
    name: "memory_save",
    label: "Notebook",
    description: [
      "Save useful knowledge for future sessions, or update a memory by ref.",
      "Put the actionable conclusion first, then supporting reasons or evidence. Save what changes a future action or prevents costly rediscovery; saving nothing is fine.",
      "Keep one coherent topic current: update it rather than appending a changelog. When correcting a claim, reconcile related memories that repeat it. Do not present guesses as verified facts.",
      "Optional tags help retrieval; reuse existing terms. Optional files identify related project paths.",
      "Use kind rule only for explicit lasting user instructions; rules are always available. The user can approve global saves, keep them project-only, or reject them. Respect their scope choice without retrying. Temporary progress belongs in handoff_update.",
    ].join("\n"),
    promptSnippet: "memory_save: save or update durable knowledge; optionally record a user-approved rule",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short topic label; required for a new memory, or the complete instruction for a rule." })),
      content: Type.Optional(Type.String({ description: "Conclusion-first Markdown; required for a new memory. When updating, replace with a complete current account, not just the latest change." })),
      ref: Type.Optional(Type.String({ description: 'Update an existing memory, e.g. "M3" or "~M1". Omitted fields keep their values.' })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional retrieval hints, e.g. ['deployment', 'systemd']." })),
      files: Type.Optional(Type.Array(Type.String(), { description: "Related project-relative files or directories." })),
      scope: Type.Optional(StringEnum(["project", "global"] as const, {
        description: "Project by default. Global is for knowledge or user instructions that apply across projects.",
      })),
      kind: Type.Optional(StringEnum(["memory", "rule"] as const, {
        description: "Memory by default; rule only for an explicit lasting user instruction.",
      })),
    }),
    prepareArguments: (raw) => splitListArgs(raw, ["files", "tags"]),
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const { project, scope: existing, global } = locate(ctx.cwd);
      const parsed = p.ref ? parseRef(p.ref) : undefined;
      if (p.ref && !parsed) throw new Error('Invalid ref. Use M3 or ~M1; list refs with memory_search "*".');
      if (p.ref && p.kind === "rule") throw new Error("Rules are edited with /nb:prefs, not a memory ref.");
      let globalTarget = parsed ? parsed.global : p.scope === "global";
      const proposedGlobal = globalTarget;
      if (parsed && p.scope && (p.scope === "global") !== parsed.global)
        throw new Error("scope conflicts with ref; omit scope when updating.");
      const title = p.title === undefined ? undefined : oneLine(p.title);
      const body = p.content?.trim();
      if (title !== undefined && !title || body !== undefined && !body)
        throw new Error("Title and content cannot be blank.");
      if (!p.ref && !title) throw new Error("A new memory or rule needs a title.");
      if (!p.ref && p.kind !== "rule" && !body)
        throw new Error("A new memory needs content. Put the useful conclusion first.");
      const secret = findSecret([title, body, ...(p.tags ?? []), ...(p.files ?? [])].join("\n"));
      if (secret) throw new Error(secretError(secret));
      if ((globalTarget || p.kind === "rule") && !ctx.hasUI)
        throw new Error("Rules and global memories need user confirmation, unavailable in this mode.");
      if (!globalTarget && !project) throw new Error("Not in a project. Use scope global only for knowledge that applies across projects.");
      const originalScope = parsed?.global ? global : existing;
      const original = parsed && originalScope ? getEntry(originalScope, parsed.id) : undefined;
      if (parsed && !original) throw new Error(`${p.ref} not found.`);
      let previous = original;
      let projectCopy = false;
      if (globalTarget) {
        const globalOption = original ? "Update globally" : "Save globally";
        const projectOption = original
          ? "Save a project-only copy (leave global memory unchanged)"
          : "Save to this project only";
        const choice = await ctx.ui.select(
          `${original ? `Update ${ref(original)}` : p.kind === "rule" ? "Save rule" : "Save memory"}?\n\n${title ?? original?.title}\n\n${clip(body ?? original?.body ?? "", CONFIRM_PREVIEW_CHARS)}`,
          [globalOption, ...(project ? [projectOption] : []), "Reject"],
        );
        if (choice !== globalOption && choice !== projectOption)
          return { content: text("The user rejected or cancelled this save. Do not retry."), details: { declined: true } };
        if (choice === projectOption && project) {
          globalTarget = false;
          projectCopy = !!original;
          previous = undefined;
        }
      }
      let scope = globalTarget ? global : existing;
      if (!scope) {
        if (p.ref && !projectCopy) throw new Error(`${p.ref} not found: this project has no notebook.`);
        const result = await resolveProjectScope(ctx, project!, rt.session.cfg.storage);
        if (!("scope" in result))
          return { content: text("The user declined this project notebook. Do not retry."), details: { declined: true } };
        scope = result.scope;
      }
      if (p.kind === "rule") {
        const line = oneLine(body ? `${title}: ${body}` : title!);
        const ok = proposedGlobal || await ctx.ui.confirm(
          `Save rule ${globalTarget ? "for all projects" : "for this project"}?`, line,
        );
        if (!ok) return { content: text("The user declined. Do not retry."), details: { declined: true } };
        const added = appendManaged(scope.agentsFile, RULE_HEADING[globalTarget ? "preference" : "convention"], line);
        if (added) rt.markSaved(ctx);
        return { content: text(`${added ? "Saved" : "Already recorded"} ${globalTarget ? "global" : "project"} rule: ${line}`), details: { label: line } };
      }
      if (globalTarget && p.files?.length) throw new Error("Related files are project-relative; omit files for global memories.");
      const files = p.files && project ? normalizeMemoryFiles(p.files, project.root) : undefined;
      const commit = !globalTarget && project ? headCommit(project.root) : undefined;
      const entry = previous
        ? updateEntry(scope, previous.id, { title, body, tags: p.tags, files,
            commit: body !== undefined || files !== undefined ? commit : previous.commit })
        : saveEntry(scope, title ?? original!.title, body ?? original!.body,
            { tags: p.tags ?? original?.tags, files, commit });
      rt.markSaved(ctx);
      const related = searchEntries([scope], [entry.title, ...entry.tags].join(" "), 3,
        { exclude: (e) => e.id === entry.id });
      const advice = related.length
        ? `\nRelated memories (check only if useful): ${related.map((h) => `${ref(h.entry)} ${h.entry.title}`).join("; ")}.`
        : "";
      return {
        content: text(`${previous ? "Updated" : "Saved"} ${ref(entry)} "${entry.title}" ${globalTarget ? "globally" : "for this project only"}.${projectCopy ? ` Global memory ${ref(original!)} was left unchanged.` : ""}${advice}`),
        details: { label: `${ref(entry)} ${entry.title}` },
      };
    },
    renderCall(args, theme) {
      return callRow(theme, "save", theme.fg("dim", args.ref ?? args.title ?? ""));
    },
    renderResult(result, _opts, theme) {
      const d = result.details as { declined?: boolean; label?: string } | undefined;
      return textRow(d?.declined ? theme.fg("warning", "declined")
        : theme.fg("muted", d?.label ?? "not saved"));
    },
  });
}
