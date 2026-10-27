import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { Type } from "typebox";
import { CONFIRM_PREVIEW_CHARS } from "../constants.ts";
import { clip } from "../format.ts";
import { headCommit } from "../git.ts";
import { resolveProjectScope } from "../flows/scope.ts";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  appendManaged,
  type EntryKind,
  findSimilar,
  getEntry,
  oneLine,
  parseRef,
  readManaged,
  ref,
  RULE_HEADING,
  type RuleKind,
  saveEntry,
  updateEntry,
} from "../store.ts";
import {
  BODY_MAX,
  clipTitle,
  findSecret,
  secretError,
} from "../validate.ts";
import { callRow, splitListArgs, text, textRow } from "./shared.ts";

interface SaveDetails {
  kind?: string;
  ref?: string;
  title?: string;
  path?: string;
  declined?: boolean;
  skipped?: boolean;
  updated?: boolean;
}

interface SaveResult {
  content: ReturnType<typeof text>;
  details: SaveDetails;
}

type RecordKind = "decision" | "lesson" | "note" | "environment";
const storedKind = (k: RecordKind): EntryKind =>
  k === "environment" ? "lesson" : k;

interface RecordParams {
  kind: string;
  title: string;
  ref?: string;
  force?: boolean;
  files?: string[];
}

const declined = (msg: string): SaveResult => ({
  content: text(msg),
  details: { declined: true },
});

/** Repo-relative note paths without leading `./` or blanks. */
export function normalizeNoteFiles(files: string[], root: string): string[] {
  return files
    .map((f) => (isAbsolute(f) ? relative(root, f) : f.trim()))
    .map((f) => f.replace(/^\.\//, ""))
    .filter(Boolean);
}

/** Normalized note paths split into those that exist and those that do not. */
export function noteFiles(
  files: string[],
  root: string,
): { files: string[]; dropped: string[] } {
  const all = normalizeNoteFiles(files, root);
  return {
    files: all.filter((f) => existsSync(join(root, f))),
    dropped: all.filter((f) => !existsSync(join(root, f))),
  };
}

/** A path inside the project, if the text mentions one. */
export function projectPathIn(text: string, root: string): string | undefined {
  if (text.includes(root)) return root;
  for (const m of text.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) {
    const token = m[0].replace(/^\.\//, "");
    if (existsSync(join(root, token))) return token;
  }
  return undefined;
}

const projectPathError = (hit: string): string =>
  `Not saved: an environment entry must hold in every repo, but this mentions ${hit} from this project. Save it with kind "lesson" instead.`;

const withNotices = (msg: string, notices: string[]): string =>
  [msg, ...notices].join(" ").trim();

async function saveRule(
  rt: Runtime,
  ctx: ExtensionContext,
  kind: RuleKind,
  title: string,
  body: string,
): Promise<SaveResult> {
  if (!ctx.hasUI)
    throw new Error(
      "Preferences and conventions need user confirmation, which is unavailable in this mode.",
    );
  const { project, global } = locate(ctx.cwd);
  const line = oneLine(body ? `${title}: ${body}` : title);
  let file = global.agentsFile;
  let where = "global AGENTS.md";
  if (kind === "convention") {
    if (!project)
      throw new Error(
        'Not inside a project. Save it as a preference or kind "environment" instead.',
      );
    const r = await resolveProjectScope(ctx, project, rt.session.cfg.storage);
    if (!("scope" in r))
      return declined(
        "The user chose not to keep a notebook for this project. Do not retry.",
      );
    file = r.scope.agentsFile;
    where = r.scope.mode === "repo" ? "project AGENTS.md" : "project notebook";
  }
  if (readManaged(file).includes(line))
    return {
      content: text(`Already recorded: ${line}`),
      details: { skipped: true, kind, title: line },
    };
  const ok = await ctx.ui.confirm(`◆ Save ${kind} to ${where}?`, line);
  if (!ok)
    return declined("The user declined. Do not retry or rephrase this save.");
  appendManaged(file, RULE_HEADING[kind], line);
  rt.markSaved(ctx);
  return {
    content: text(`Saved ${kind}: ${line}`),
    details: { kind, title: line, path: file },
  };
}

async function confirmGlobalSave(
  ctx: ExtensionContext,
  heading: string,
  title: string,
  body: string,
): Promise<boolean> {
  if (!ctx.hasUI)
    throw new Error(
      "Global entries need user confirmation, which is unavailable in this mode.",
    );
  return ctx.ui.confirm(
    heading,
    `${oneLine(title)}\n\n${clip(body, CONFIRM_PREVIEW_CHARS)}`,
  );
}

async function saveRecord(
  rt: Runtime,
  ctx: ExtensionContext,
  kind: RecordKind,
  p: RecordParams,
  title: string,
  body: string,
  notices: string[],
): Promise<SaveResult> {
  const { project, global } = locate(ctx.cwd);
  let scope: Scope;
  if (kind === "environment") {
    scope = global;
    if (project) {
      const hit = projectPathIn(`${title}\n${body}`, project.root);
      if (hit) throw new Error(projectPathError(hit));
    }
  } else {
    if (!project)
      throw new Error(
        'Not inside a project. Decisions, lessons and notes belong to a project. If this is about the user\'s machine or accounts, use kind "environment".',
      );
    const r = await resolveProjectScope(ctx, project, rt.session.cfg.storage);
    if (!("scope" in r))
      return declined(
        "The user chose not to save this in a project notebook. Do not retry.",
      );
    scope = r.scope;
  }

  const stored = storedKind(kind);
  const similar = p.force ? undefined : findSimilar(scope, stored, title);
  if (similar) {
    const r = ref(similar);
    return {
      content: text(
        `Not saved: similar to ${r} "${similar.title}". To update it, call memory_save again with ref "${r}". If it is genuinely different, call again with force: true. If it adds nothing, skip it.`,
      ),
      details: { skipped: true, ref: r, title: similar.title },
    };
  }
  if (
    scope.kind === "global" &&
    !(await confirmGlobalSave(
      ctx,
      "◆ Save environment entry? It will be shown in every session.",
      title,
      body,
    ))
  )
    return declined("The user declined. Do not retry or rephrase this save.");

  let meta: { files?: string[]; commit?: string } = {};
  if (kind === "note" && project) {
    const { files, dropped } = noteFiles(p.files ?? [], project.root);
    meta = { files, commit: headCommit(project.root) };
    if (dropped.length) notices.push(`Ignored missing paths: ${dropped.join(", ")}.`);
  }
  const entry = saveEntry(scope, stored, title, body, meta);
  rt.markSaved(ctx);
  return {
    content: text(
      withNotices(`Saved ${ref(entry)} "${entry.title}".`, notices),
    ),
    details: {
      kind: stored,
      ref: ref(entry),
      title: entry.title,
      path: entry.path,
    },
  };
}

async function updateRecord(
  rt: Runtime,
  ctx: ExtensionContext,
  p: RecordParams,
  title: string,
  body: string,
  notices: string[],
): Promise<SaveResult> {
  const parsed = parseRef(p.ref ?? "");
  if (!parsed)
    throw new Error(
      `ref must look like D3, L2, N1 or ~L1. Got "${p.ref}".`,
    );
  if (p.kind === "preference" || p.kind === "convention")
    throw new Error(
      `ref works for decisions, lessons, notes and environment entries, not ${p.kind}s.`,
    );
  const { project, scope: projectScope, global } = locate(ctx.cwd);
  const scope = parsed.global ? global : projectScope;
  const entry = scope && getEntry(scope, parsed.kind, parsed.id);
  if (!scope || !entry)
    throw new Error(`${p.ref} not found. Check refs with memory_search.`);
  if (entry.status !== "active")
    throw new Error(
      `${p.ref} is ${entry.status}; save a new entry instead.`,
    );
  if (parsed.global && project) {
    const hit = projectPathIn(`${title}\n${body}`, project.root);
    if (hit) throw new Error(projectPathError(hit));
  }
  if (
    parsed.global &&
    !(await confirmGlobalSave(
      ctx,
      `◆ Update global entry ${ref(entry)}? It is shown in every session.`,
      title,
      body || entry.body,
    ))
  )
    return declined("The user declined. Do not retry or rephrase this save.");

  const patch: { title: string; body?: string; files?: string[]; commit?: string } =
    { title, body: body || undefined };
  if (entry.kind === "note" && project) {
    patch.commit = headCommit(project.root);
    if (p.files) {
      const { files, dropped } = noteFiles(p.files, project.root);
      patch.files = files;
      if (dropped.length)
        notices.push(`Ignored missing paths: ${dropped.join(", ")}.`);
    }
  }
  const updated = updateEntry(scope, entry.kind, entry.id, patch);
  rt.markSaved(ctx);
  return {
    content: text(
      withNotices(`Updated ${ref(updated)} "${updated.title}".`, notices),
    ),
    details: {
      kind: updated.kind,
      ref: ref(updated),
      title: updated.title,
      path: updated.path,
      updated: true,
    },
  };
}

export function registerMemorySave(rt: Runtime): void {
  rt.pi.registerTool({
    name: "memory_save",
    label: "Notebook",
    description: [
      "Save memory that later sessions will see. Pick the kind:",
      "- preference: how the user wants you to work, in any repo. One line, e.g. 'Use pnpm, not npm'.",
      "- convention: a rule for this repository. One line.",
      "- decision: a choice between real alternatives in this project, and why.",
      "- lesson: a non-obvious problem in this project and its fix.",
      "- note: how part of this project's code works. Title 'area: summary'. Set files.",
      "- environment: a fact about the user's machine, shell, accounts or installed tools that is true in every repo, e.g. 'brew postgres needs a restart after config edits'. Not language, library or project knowledge.",
      "If an entry in the notebook index already covers the topic, update it by passing its ref instead of adding a new one.",
      "In the body, mention files and topics, not other entries' refs.",
      "Skip trivia and temporary state. Preferences, conventions and environment entries ask the user to confirm; if declined, do not retry.",
    ].join("\n"),
    promptSnippet:
      "memory_save: record or update a preference, convention, decision, lesson, note or environment fact",
    parameters: Type.Object({
      kind: StringEnum([
        "preference",
        "convention",
        "decision",
        "lesson",
        "note",
        "environment",
      ] as const),
      title: Type.String({
        description:
          "One short line, under 120 characters. For preference and convention, the whole rule.",
      }),
      body: Type.Optional(
        Type.String({
          description:
            "Optional details. Decision: context, choice, consequences. Lesson: symptom, cause, fix. Note: details and key paths.",
        }),
      ),
      ref: Type.Optional(
        Type.String({
          description:
            'Update this existing entry instead of adding one, e.g. "D3" or "~L1". The title is replaced; body and files only if given.',
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Save even though a similar entry exists. Only after checking it is genuinely different.",
        }),
      ),
      files: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Notes only: repo-relative files or directories the note describes. Paths that do not exist are ignored.",
        }),
      ),
    }),
    prepareArguments: (raw) => {
      const a = splitListArgs(raw, ["files"]) as Record<string, unknown>;
      if (a.scope === "global" && (a.kind === "lesson" || a.kind === "decision"))
        a.kind = "environment";
      delete a.scope;
      delete a.supersedes;
      return a as never;
    },
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const body = (p.body ?? "").trim();
      const secret = findSecret(`${p.title}\n${body}`);
      if (secret) throw new Error(secretError(secret));
      if (body.length > BODY_MAX)
        throw new Error(
          `Not saved: body is ${body.length} characters; keep it under 8000. Move detail into files and reference them.`,
        );
      if (!p.ref && (p.kind === "preference" || p.kind === "convention"))
        return saveRule(rt, ctx, p.kind, p.title, body);
      const { title, clipped } = clipTitle(p.title);
      const notices = clipped ? ["Title shortened to 120 characters."] : [];
      if (p.ref) return updateRecord(rt, ctx, p, title, body, notices);
      return saveRecord(rt, ctx, p.kind as RecordKind, p, title, body, notices);
    },

    renderCall(args, theme) {
      return callRow(
        theme,
        `save ${args.kind ?? ""}`,
        theme.fg("dim", `"${args.title ?? ""}"`),
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as SaveDetails | undefined;
      if (!d) {
        const first = result.content[0];
        return textRow(
          theme.fg("error", first?.type === "text" ? first.text : "failed"),
        );
      }
      if (d.declined) return textRow(theme.fg("warning", "✗ declined"));
      if (d.skipped && !d.ref)
        return textRow(
          `${theme.fg("dim", "= already recorded ")}${theme.fg("muted", d.title ?? "")}`,
        );
      if (d.skipped)
        return textRow(
          `${theme.fg("warning", "≈ similar to ")}${theme.fg("accent", d.ref ?? "")} ${theme.fg("muted", d.title ?? "")}`,
        );
      const tag = d.ref ?? d.kind ?? "";
      return textRow(
        `${theme.fg("success", "✓ ")}${theme.fg("accent", tag)} ${theme.fg("muted", d.title ?? "")}${d.updated ? theme.fg("dim", " (updated)") : ""}`,
      );
    },
  });
}
