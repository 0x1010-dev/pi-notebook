import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { loadConfig } from "./config.ts";
import { guardToolCall } from "./guard.ts";
import { buildSection, estimateTokens } from "./inject.ts";
import {
  agentDir,
  existingProjectScope,
  findProject,
  globalScope,
  notebookHome,
  type Project,
  projectScope,
  type Scope,
  type StorageMode,
} from "./paths.ts";
import { curatePrompt, wrapPrompt } from "./prompts.ts";
import {
  COMMIT_RE,
  detectNudge,
  freshSignals,
  type Hint,
  looksLikePreference,
  NUDGE_HINT,
  type NudgeKind,
  nudgeText,
  PREFERENCE_NUDGE,
} from "./signals.ts";
import { loadState, saveState } from "./state.ts";
import {
  appendManaged,
  type Entry,
  findSimilar,
  getEntry,
  initScope,
  listAll,
  oneLine,
  parseRef,
  readHandoff,
  readManaged,
  recall,
  ref,
  replaceManaged,
  retireEntry,
  saveEntry,
  searchEntries,
  writeHandoff,
} from "./store.ts";
import { formatTodos, readTodos } from "./todos.ts";
import { NotebookView, statusLine, type ViewData } from "./ui.ts";
import { checkStructure, findSecret, secretError } from "./validate.ts";

const STATUS_KEY = "notebook";
const NUDGE_TYPE = "notebook-nudge";
const HINT_TTL_RUNS = 5;

type Resolution = { scope: Scope } | { global: true } | { cancelled: true };

interface SaveDetails {
  kind?: string;
  ref?: string;
  title?: string;
  path?: string;
  declined?: boolean;
  skipped?: boolean;
}

const text = (t: string) => [{ type: "text" as const, text: t }];

function sameFile(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

/** Keep AGENTS.md content current without /reload after the extension writes to it. */
function syncContextFile(
  files: { path: string; content: string }[],
  path: string,
  content: string,
  where: "start" | "end",
): void {
  const hit = files.find((f) => sameFile(f.path, path));
  if (hit) hit.content = content;
  else if (where === "start") files.unshift({ path, content });
  else files.push({ path, content });
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export default function notebook(pi: ExtensionAPI) {
  let cfg = loadConfig();
  let hint: Hint | undefined;
  let hintAge = 0;
  let suggested = new Set<string>();
  let pendingNudge: NudgeKind | undefined;
  let signals = freshSignals();
  let fired = new Set<NudgeKind>();
  let turnsSinceSave = 0;
  let turnsSinceNudge = 0;
  let errorsSinceSuccess = 0;
  let completedTodos = 0;
  let contextNudged = false;
  let suppressNudgeOnce = false;
  const warnings = new Map<string, string>();
  let recalled = new Set<string>();
  // Frozen per session so the system prompt prefix (and the model's KV cache) stays stable.
  let snapshot:
    | {
        section: string;
        files: { path: string; content: string; where: "start" | "end" }[];
      }
    | undefined;
  const invalidate = () => {
    snapshot = undefined;
  };

  const locate = (cwd: string) => {
    const project = findProject(cwd);
    return {
      project,
      scope: project ? existingProjectScope(project) : undefined,
      global: globalScope(),
    };
  };

  const setHint = (next: Hint | undefined) => {
    hint = next;
    hintAge = 0;
  };

  function refreshStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const { project, scope, global } = locate(ctx.cwd);
    ctx.ui.setStatus(
      STATUS_KEY,
      statusLine(ctx.ui.theme, {
        project,
        scope,
        projectEntries: scope ? listAll(scope) : [],
        globalEntries: listAll(global),
        handoff: scope ? readHandoff(scope) : undefined,
        hint,
      }),
    );
  }

  function markSaved(ctx: ExtensionContext): void {
    turnsSinceSave = 0;
    fired = new Set();
    signals = freshSignals();
    if (hint && hint.command !== "/nb:curate") setHint(undefined);
    refreshStatus(ctx);
  }

  async function resolveProjectScope(
    ctx: ExtensionContext,
    project: Project,
    allowGlobal: boolean,
  ): Promise<Resolution> {
    const existing = existingProjectScope(project);
    if (existing) return { scope: existing };
    const state = loadState();
    if (state.declined.includes(project.root) || !ctx.hasUI)
      return { cancelled: true };

    const modes: StorageMode[] =
      cfg.storage === "repo" ? ["repo", "local"] : ["local", "repo"];
    const label = (m: StorageMode) =>
      m === "repo"
        ? "Create notebook in repo (.pi/notebook)"
        : "Create notebook locally (~/.pi/agent/pi-notebook)";
    const GLOBAL = "Save globally instead";
    const NEVER = "Never ask for this repo";
    const options = [
      ...modes.map(label),
      ...(allowGlobal ? [GLOBAL] : []),
      "Not now",
      NEVER,
    ];
    const choice = await ctx.ui.select(
      `◆ No notebook for ${project.name} yet`,
      options,
    );

    const mode = modes.find((m) => label(m) === choice);
    if (mode) {
      const scope = projectScope(project, mode);
      initScope(scope);
      return { scope };
    }
    if (choice === GLOBAL) return { global: true };
    if (choice === NEVER) {
      state.declined.push(project.root);
      saveState(state);
    }
    return { cancelled: true };
  }

  function viewData(ctx: ExtensionContext): ViewData {
    const { project, scope, global } = locate(ctx.cwd);
    return {
      project,
      scope,
      projectEntries: scope ? listAll(scope) : [],
      globalEntries: listAll(global),
      handoff: scope ? readHandoff(scope) : undefined,
      hint,
      preferences: readManaged(global.agentsFile),
      conventions: scope ? readManaged(scope.agentsFile) : [],
      injectedTokens: estimateTokens(
        buildSection({
          project,
          scope,
          global,
          budgetTokens: cfg.injectBudgetTokens,
          globalLimit: cfg.globalIndexLimit,
        }),
      ),
    };
  }

  function sendOwnPrompt(ctx: ExtensionContext, prompt: string): void {
    suppressNudgeOnce = true;
    invalidate();
    setHint(undefined);
    if (ctx.isIdle()) pi.sendUserMessage(prompt);
    else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
    refreshStatus(ctx);
  }

  // Lifecycle

  pi.on("session_start", async (event, ctx) => {
    cfg = loadConfig();
    invalidate();
    recalled = new Set();
    setHint(undefined);
    suggested = new Set();
    pendingNudge = undefined;
    signals = freshSignals();
    fired = new Set();
    turnsSinceSave = 0;
    turnsSinceNudge = cfg.nudgeCooldownTurns;
    errorsSinceSuccess = 0;
    completedTodos = readTodos(ctx.sessionManager.getBranch()).completed;
    contextNudged = false;
    refreshStatus(ctx);

    if (!ctx.hasUI || (event.reason !== "startup" && event.reason !== "new"))
      return;
    const { project, scope } = locate(ctx.cwd);
    const h = scope ? readHandoff(scope) : undefined;
    if (project && h?.goal) {
      const next = h.nextSteps[0] ? `  ›  ${h.nextSteps[0]}` : "";
      ctx.ui.notify(`◆ ${project.name}: ${h.goal}${next}`, "info");
    }
  });

  pi.on("session_compact", async (_event, ctx) => {
    invalidate();
    contextNudged = false;
    const { scope } = locate(ctx.cwd);
    const h = scope ? readHandoff(scope) : undefined;
    const fresh = h && Date.now() - Date.parse(h.updated) < 10 * 60_000;
    if (scope && !fresh)
      setHint({ command: "/nb:wrap", reason: "to save progress" });
    refreshStatus(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const { project, scope, global } = locate(ctx.cwd);
    if (!snapshot || cfg.refreshSection === "turn") {
      const files: { path: string; content: string; where: "start" | "end" }[] =
        [];
      const g = readIfExists(global.agentsFile);
      if (g !== undefined)
        files.push({ path: global.agentsFile, content: g, where: "start" });
      const p =
        scope?.mode === "repo" ? readIfExists(scope.agentsFile) : undefined;
      if (scope && p !== undefined)
        files.push({ path: scope.agentsFile, content: p, where: "end" });
      snapshot = {
        section: buildSection({
          project,
          scope,
          global,
          budgetTokens: cfg.injectBudgetTokens,
          globalLimit: cfg.globalIndexLimit,
        }),
        files,
      };
    }
    const opts = event.systemPromptOptions;
    opts.sections.notebook = snapshot.section;
    for (const f of snapshot.files)
      syncContextFile(opts.contextFiles, f.path, f.content, f.where);

    const suppress = suppressNudgeOnce;
    suppressNudgeOnce = false;
    const queued = pendingNudge;
    pendingNudge = undefined;
    if (suppress || event.messageType !== "user") return;

    const notes: string[] = [];
    if (cfg.nudgeModel && looksLikePreference(event.prompt))
      notes.push(PREFERENCE_NUDGE);
    if (cfg.nudgeModel && queued) notes.push(nudgeText(queued));
    const hits = recall(
      scope ? [scope, global] : [global],
      event.prompt,
      cfg.autoRecall,
    ).filter((e) => !recalled.has(ref(e)));
    if (hits.length) {
      for (const e of hits) recalled.add(ref(e));
      const clip = (b: string) => (b.length > 600 ? `${b.slice(0, 600)}…` : b);
      notes.push(
        `[pi-notebook] Possibly relevant notebook entries. Use them if they apply, ignore them otherwise.\n\n${hits
          .map((e) => `${ref(e)} ${e.title}\n${clip(e.body)}`)
          .join("\n\n")}`,
      );
    }
    if (notes.length === 0) return;
    return {
      message: {
        customType: NUDGE_TYPE,
        content: notes.join("\n\n"),
        display: false,
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!cfg.guard) return;
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
      warnings.set(event.toolCallId, verdict.reason);
  });

  pi.on("tool_result", async (event, ctx) => {
    const warning = warnings.get(event.toolCallId);
    warnings.delete(event.toolCallId);
    if (
      event.toolName === "bash" &&
      !event.isError &&
      COMMIT_RE.test(String(event.input.command ?? ""))
    ) {
      signals.committed = true;
    }
    if (event.isError) errorsSinceSuccess++;
    else {
      if (errorsSinceSuccess >= 2) signals.recovered = true;
      errorsSinceSuccess = 0;
    }

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

  pi.on("turn_end", async (event, ctx) => {
    turnsSinceSave++;
    turnsSinceNudge++;
    const done = readTodos(ctx.sessionManager.getBranch()).completed;
    if (done > completedTodos) signals.todoCompleted = true;
    completedTodos = done;

    const percent = ctx.getContextUsage()?.percent ?? 0;
    const { scope } = locate(ctx.cwd);
    const kind = detectNudge(
      {
        ...signals,
        contextHigh:
          cfg.wrapAtContextPercent > 0 &&
          !contextNudged &&
          percent >= cfg.wrapAtContextPercent,
        handoffMissing: !!scope && !readHandoff(scope),
        turnsSinceSave,
      },
      {
        checkpointTurns: cfg.checkpointTurns,
        handoffAfterTurns: cfg.handoffAfterTurns,
        cooldownTurns: cfg.nudgeCooldownTurns,
      },
      fired,
      turnsSinceNudge,
    );
    if (!kind) return;

    fired.add(kind);
    turnsSinceNudge = 0;
    if (kind === "context") contextNudged = true;
    if (kind === "milestone") {
      signals.committed = false;
      signals.todoCompleted = false;
    }
    if (kind === "lesson") signals.recovered = false;
    setHint(NUDGE_HINT[kind]);
    refreshStatus(ctx);
    if (!cfg.nudgeModel) return;
    // A final turn has no next request in this run, so defer to the next prompt.
    if (event.toolResults.length === 0) {
      pendingNudge = kind;
      return;
    }
    return {
      entries: [
        {
          type: "custom_message",
          customType: NUDGE_TYPE,
          content: nudgeText(kind),
          display: false,
        },
      ],
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    const todos = readTodos(ctx.sessionManager.getBranch());
    if (hint && ++hintAge >= HINT_TTL_RUNS) setHint(undefined);

    const { scope, global } = locate(ctx.cwd);
    if (!hint) {
      const state = loadState();
      const fresh = [scope, global]
        .filter((s): s is Scope => !!s)
        .reduce(
          (n, s) =>
            n + Math.max(0, listAll(s).length - (state.curated[s.dir] ?? 0)),
          0,
        );
      if (fresh >= cfg.curateAfter)
        setHint({ command: "/nb:curate", reason: `to tidy ${fresh} entries` });
    }

    if (scope) {
      const h = readHandoff(scope);
      const lines = formatTodos(todos);
      if (h && lines.join("\n") !== h.todos.join("\n"))
        writeHandoff(scope, { ...h, todos: lines });
    }
    refreshStatus(ctx);
  });

  // Tools

  pi.registerTool({
    name: "memory_save",
    label: "Notebook",
    description: [
      "Save durable memory that persists across sessions. Choose kind by asking:",
      "- preference: how the user likes things done, anywhere.",
      "- convention: a rule for this repository.",
      "- decision: a choice made between real alternatives. Body: Context, Decision, Consequences.",
      "- lesson: a non-obvious problem and its fix. Body: Symptom, Cause, Fix.",
      "Do not save trivia, temporary state, or anything already in the notebook index.",
      "Preferences and conventions require user confirmation. If declined, do not retry.",
    ].join("\n"),
    promptSnippet:
      "memory_save: record a preference, convention, decision or lesson in the notebook",
    parameters: Type.Object({
      kind: StringEnum([
        "preference",
        "convention",
        "decision",
        "lesson",
      ] as const),
      title: Type.String({
        description:
          "One short line. For preferences and conventions, the full rule.",
      }),
      body: Type.Optional(
        Type.String({ description: "Details for decisions and lessons." }),
      ),
      scope: Type.Optional(
        StringEnum(["project", "global"] as const, {
          description:
            "Decisions and lessons only. Default and usual choice: project. Use 'global' only for facts about the user's own setup that matter across projects (machines, accounts, shell, installed tools, local services), for example 'brew postgres needs a restart after config changes'. Anything learned while working on a project stays in the project, including general language or library knowledge. When unsure, use project.",
        }),
      ),
      supersedes: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Refs of entries this one replaces, for example ["D3"]. Use it to merge duplicates or correct outdated entries. When saving globally, project refs promote those entries to global.',
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Save even though a similar entry exists. Only after checking it is genuinely different.",
        }),
      ),
    }),
    prepareArguments: (args) => {
      const a = { ...(args as Record<string, unknown>) };
      if (typeof a.supersedes === "string")
        a.supersedes = a.supersedes.split(/[\s,]+/).filter(Boolean);
      return a as never;
    },
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const { project, global } = locate(ctx.cwd);
      const body = (p.body ?? "").trim();
      const declined = (msg: string) => ({
        content: text(msg),
        details: { declined: true } as SaveDetails,
      });
      const secret = findSecret(`${p.title}\n${body}`);
      if (secret) throw new Error(secretError(secret));

      if (p.kind === "preference" || p.kind === "convention") {
        if (!ctx.hasUI)
          throw new Error(
            "Preferences and conventions need user confirmation, which is unavailable in this mode.",
          );
        const line = oneLine(body ? `${p.title}: ${body}` : p.title);
        let file = global.agentsFile;
        let where = "global AGENTS.md";
        if (p.kind === "convention") {
          if (!project)
            throw new Error(
              "Not inside a project. Save it as a preference or a global lesson instead.",
            );
          const r = await resolveProjectScope(ctx, project, false);
          if (!("scope" in r))
            return declined(
              "The user chose not to keep a notebook for this project. Do not retry.",
            );
          file = r.scope.agentsFile;
          where =
            r.scope.mode === "repo" ? "project AGENTS.md" : "project notebook";
        }
        const ok = await ctx.ui.confirm(`◆ Save ${p.kind} to ${where}?`, line);
        if (!ok)
          return declined(
            "The user declined. Do not retry or rephrase this save.",
          );
        appendManaged(
          file,
          p.kind === "preference" ? "## Preferences" : "## Conventions",
          line,
        );
        markSaved(ctx);
        return {
          content: text(`Saved ${p.kind}: ${line}`),
          details: { kind: p.kind, title: line, path: file } as SaveDetails,
        };
      }

      const shapeError = checkStructure(p.kind, body);
      if (shapeError) throw new Error(shapeError);

      let scope: Scope = global;
      if (p.scope !== "global" && project) {
        const r = await resolveProjectScope(ctx, project, true);
        if ("cancelled" in r)
          return declined(
            "The user chose not to save this in a project notebook. Do not retry.",
          );
        if ("scope" in r) scope = r.scope;
      }
      const nb = locate(ctx.cwd).scope;
      const supersedes: number[] = [];
      const promoted: number[] = [];
      for (const raw of p.supersedes ?? []) {
        const parsed = parseRef(raw);
        if (!parsed || parsed.kind !== p.kind)
          throw new Error(
            `supersedes must reference ${p.kind}s, for example ${ref({ scope: scope.kind, kind: p.kind, id: 3 })}. Got "${raw}".`,
          );
        if (parsed.global === (scope.kind === "global")) {
          supersedes.push(parsed.id);
        } else if (scope.kind === "global" && nb && getEntry(nb, p.kind, parsed.id)) {
          promoted.push(parsed.id);
        } else {
          throw new Error(
            scope.kind === "global"
              ? `${raw} not found in this project's notebook.`
              : `A project entry cannot replace a global one (${raw}).`,
          );
        }
      }
      const similar =
        p.force || supersedes.length || promoted.length
          ? undefined
          : findSimilar(scope, p.kind, p.title);
      if (similar) {
        const r = ref(similar);
        return {
          content: text(
            `Not saved: similar to ${r} "${similar.title}". To replace it, call again with supersedes ["${r}"]. If it is genuinely different, call again with force: true. If it adds nothing, skip it.`,
          ),
          details: {
            skipped: true,
            ref: r,
            title: similar.title,
          } as SaveDetails,
        };
      }
      if (scope.kind === "global") {
        if (!ctx.hasUI)
          throw new Error(
            "Global entries need user confirmation, which is unavailable in this mode. Save it in the project instead.",
          );
        const preview = body.length > 400 ? `${body.slice(0, 400)}…` : body;
        const ok = await ctx.ui.confirm(
          `◆ Save global ${p.kind}? It will be shown in every session.`,
          `${oneLine(p.title)}\n\n${preview}`,
        );
        if (!ok)
          return declined(
            "The user declined. Do not retry or rephrase this save.",
          );
      }
      const entry = saveEntry(scope, p.kind, p.title, body, supersedes);
      for (const id of promoted) retireEntry(nb!, p.kind, id, ref(entry));
      markSaved(ctx);
      const replaced =
        supersedes.length || promoted.length
          ? `, superseding ${(p.supersedes ?? []).join(", ")}`
          : "";
      return {
        content: text(`Saved ${ref(entry)} "${entry.title}"${replaced}.`),
        details: {
          kind: p.kind,
          ref: ref(entry),
          title: entry.title,
          path: entry.path,
        } as SaveDetails,
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("notebook "))}${theme.fg("muted", `save ${args.kind ?? ""}`)} ${theme.fg("dim", `"${args.title ?? ""}"`)}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as SaveDetails | undefined;
      if (!d) {
        const first = result.content[0];
        return new Text(
          theme.fg("error", first?.type === "text" ? first.text : "failed"),
          0,
          0,
        );
      }
      if (d.declined) return new Text(theme.fg("warning", "✗ declined"), 0, 0);
      if (d.skipped)
        return new Text(
          `${theme.fg("warning", "≈ similar to ")}${theme.fg("accent", d.ref ?? "")} ${theme.fg("muted", d.title ?? "")}`,
          0,
          0,
        );
      const tag = d.ref ?? d.kind ?? "";
      return new Text(
        `${theme.fg("success", "✓ ")}${theme.fg("accent", tag)} ${theme.fg("muted", d.title ?? "")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Notebook",
    description:
      'Search notebook decisions and lessons (project and global). Pass keywords to search, one or more refs ("D3 ~L1") to read entries in full, or "*" to list every entry.',
    promptSnippet:
      "memory_search: search, list, or read notebook decisions and lessons",
    parameters: Type.Object({
      query: Type.String({
        description: 'Keywords, refs like "D3 L1", or "*"',
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max keyword results, default 8" }),
      ),
    }),

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const { scope, global } = locate(ctx.cwd);
      const scopes = scope ? [scope, global] : [global];
      const label = (e: Entry) => `${ref(e)} ${e.title}`;
      const head = (e: Entry) =>
        `${ref(e)} [${e.status}${e.supersededBy ? ` by ${e.supersededBy}` : ""}] ${e.title} (${e.date})`;

      if (p.query.trim() === "*") {
        const all = scopes.flatMap((s) => listAll(s));
        return {
          content: text(
            all.length ? all.map(head).join("\n") : "The notebook is empty.",
          ),
          details: { refs: all.map(label) },
        };
      }

      const words = p.query
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
      const parsed = words.map(parseRef);
      if (words.length && parsed.every(Boolean)) {
        const found: Entry[] = [];
        const missing: string[] = [];
        parsed.forEach((r, i) => {
          const s = r!.global ? global : scope;
          const e = s ? getEntry(s, r!.kind, r!.id) : undefined;
          if (e) found.push(e);
          else missing.push(words[i]);
        });
        const parts = found.map((e) => `${head(e)}\n\n${e.body}`);
        if (missing.length) parts.push(`Not found: ${missing.join(", ")}`);
        return {
          content: text(parts.join("\n\n---\n\n")),
          details: { refs: found.map(label) },
        };
      }

      const hits = searchEntries(scopes, p.query, p.limit ?? 8);
      const body = hits.length
        ? `${hits.map((h) => `${head(h.entry)}\n  ${h.snippet}`).join("\n")}\n\nPass refs to read entries in full.`
        : "No matches.";
      return {
        content: text(body),
        details: { refs: hits.map((h) => label(h.entry)) },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("notebook "))}${theme.fg("muted", "search")} ${theme.fg("dim", `"${args.query ?? ""}"`)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme) {
      const refs =
        (result.details as { refs?: string[] } | undefined)?.refs ?? [];
      if (refs.length === 0)
        return new Text(theme.fg("dim", "no matches"), 0, 0);
      const shown = expanded ? refs : refs.slice(0, 3);
      const lines = shown.map((r) => {
        const [tag, ...rest] = r.split(" ");
        return `${theme.fg("accent", tag)} ${theme.fg("muted", rest.join(" "))}`;
      });
      if (!expanded && refs.length > 3)
        lines.push(theme.fg("dim", `… ${refs.length - 3} more`));
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  pi.registerTool({
    name: "handoff_update",
    label: "Notebook",
    description:
      "Replace this project's cross-session handoff: what we are doing, where it stands, what comes next. Call it when the work state meaningfully changes, so a later session can resume.",
    promptSnippet:
      "handoff_update: record current goal, status and next steps for the next session",
    parameters: Type.Object({
      goal: Type.String({
        description: "The overall goal of the current work, one line.",
      }),
      status: Type.String({
        description: "Where things stand now, one or two sentences.",
      }),
      next_steps: Type.Array(Type.String(), {
        description: "Concrete next actions, in order.",
      }),
      blockers: Type.Optional(
        Type.Array(Type.String(), {
          description: "Open problems or questions.",
        }),
      ),
      notes: Type.Optional(
        Type.String({
          description: "Anything else a fresh session must know.",
        }),
      ),
    }),
    executionMode: "sequential",

    async execute(_id, p, _signal, _onUpdate, ctx) {
      const { project, scope } = locate(ctx.cwd);
      if (!project)
        return {
          content: text("Not inside a project; no handoff needed."),
          details: undefined,
        };
      if (!scope) {
        return {
          content: text(
            "This project has no notebook, so the handoff was not saved. Do not retry. The user can run /nb:init.",
          ),
          details: undefined,
        };
      }
      const secret = findSecret(
        [
          p.goal,
          p.status,
          ...p.next_steps,
          ...(p.blockers ?? []),
          p.notes ?? "",
        ].join("\n"),
      );
      if (secret) throw new Error(secretError(secret));
      writeHandoff(scope, {
        goal: oneLine(p.goal),
        status: p.status.trim(),
        nextSteps: p.next_steps,
        blockers: p.blockers ?? [],
        notes: p.notes ?? "",
        todos: formatTodos(readTodos(ctx.sessionManager.getBranch())),
        updated: new Date().toISOString(),
      });
      markSaved(ctx);
      return {
        content: text("Handoff updated."),
        details: { goal: oneLine(p.goal), next: p.next_steps.length },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("notebook "))}${theme.fg("muted", "handoff")} ${theme.fg("dim", args.goal ?? "")}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as { goal: string; next: number } | undefined;
      if (!d) return new Text(theme.fg("dim", "skipped"), 0, 0);
      return new Text(
        `${theme.fg("success", "✓ ")}${theme.fg("muted", "handoff")} ${theme.fg("dim", `· ${d.next} next steps`)}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "suggest_command",
    label: "Notebook",
    description:
      "Suggest a notebook command to the user through the status line. It does not interrupt or send a message. Use rarely: 'wrap' after finishing meaningful work, 'curate' when the notebook has duplicates or stale entries, 'remember' when the user stated a preference you did not save, 'init' when a project would benefit from a notebook.",
    promptSnippet:
      "suggest_command: quietly suggest /nb:wrap, /nb:curate, /nb:remember or /nb:init to the user",
    parameters: Type.Object({
      command: StringEnum(["wrap", "curate", "remember", "init"] as const),
      reason: Type.String({
        description:
          "Why, in a few words starting with 'to', for example 'to record the auth decision'.",
      }),
    }),

    async execute(_id, p, _signal, _onUpdate, ctx) {
      if (suggested.has(p.command)) {
        return {
          content: text("Already suggested this session. Continue your work."),
          details: undefined,
        };
      }
      suggested.add(p.command);
      setHint({ command: `/nb:${p.command}`, reason: oneLine(p.reason) });
      refreshStatus(ctx);
      return {
        content: text("Shown in the status line. Continue your work."),
        details: { command: `/nb:${p.command}` },
      };
    },

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("notebook "))}${theme.fg("muted", "suggest")} ${theme.fg("accent", `/nb:${args.command ?? ""}`)}`,
        0,
        0,
      );
    },

    renderResult(result, _opts, theme) {
      const d = result.details as { command: string } | undefined;
      return new Text(
        d
          ? `${theme.fg("accent", "▸ ")}${theme.fg("dim", "shown in status line")}`
          : theme.fg("dim", "already suggested"),
        0,
        0,
      );
    },
  });

  // Commands

  pi.registerCommand("nb", {
    description: "Show the notebook",
    handler: async (_args, ctx) => {
      const data = viewData(ctx);
      if (ctx.mode !== "tui") {
        ctx.ui.notify(
          `notebook: ${data.projectEntries.length} project entries, ${data.globalEntries.length} global entries`,
          "info",
        );
        return;
      }
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => new NotebookView(data, theme, () => done()),
      );
    },
  });

  pi.registerCommand("nb:init", {
    description: "Create a notebook for this project (repo or local)",
    getArgumentCompletions: (prefix) =>
      (["repo", "local"] as const)
        .filter((m) => m.startsWith(prefix.trim()))
        .map((m) => ({ value: m, label: m })),
    handler: async (args, ctx) => {
      const project = findProject(ctx.cwd);
      if (!project) {
        ctx.ui.notify("Not inside a git repository.", "warning");
        return;
      }
      const existing = existingProjectScope(project);
      if (existing) {
        ctx.ui.notify(`Notebook already exists at ${existing.dir}`, "info");
        return;
      }
      let mode: StorageMode | undefined =
        args.trim() === "repo" || args.trim() === "local"
          ? (args.trim() as StorageMode)
          : undefined;
      if (!mode) {
        const modes: StorageMode[] =
          cfg.storage === "repo" ? ["repo", "local"] : ["local", "repo"];
        const labels = modes.map((m): string =>
          m === "repo"
            ? "In repo (.pi/notebook, commit it)"
            : "Local (~/.pi/agent/pi-notebook)",
        );
        const choice = await ctx.ui.select(
          `◆ Create notebook for ${project.name}`,
          labels,
        );
        mode = modes[labels.indexOf(choice ?? "")];
      }
      if (!mode) return;
      const scope = projectScope(project, mode);
      initScope(scope);
      const state = loadState();
      if (state.declined.includes(project.root)) {
        state.declined = state.declined.filter((r) => r !== project.root);
        saveState(state);
      }
      if (hint?.command === "/nb:init") setHint(undefined);
      invalidate();
      ctx.ui.notify(`◆ Notebook created at ${scope.dir}`, "info");
      refreshStatus(ctx);
    },
  });

  pi.registerCommand("nb:remember", {
    description: "Save a preference or project convention without the model",
    handler: async (args, ctx) => {
      const input =
        args.trim() ||
        (await ctx.ui.input("◆ Remember", "e.g. use pnpm, not npm"))?.trim();
      if (!input) return;
      const secret = findSecret(input);
      if (secret) {
        ctx.ui.notify(
          `Not saved: looks like it contains a ${secret}.`,
          "error",
        );
        return;
      }
      const { project, global } = locate(ctx.cwd);
      let file = global.agentsFile;
      let kind = "preference";
      if (project) {
        const PREF = "Preference (everywhere)";
        const CONV = `Convention (${project.name} only)`;
        const choice = await ctx.ui.select("◆ Remember as", [PREF, CONV]);
        if (!choice) return;
        if (choice === CONV) {
          const r = await resolveProjectScope(ctx, project, false);
          if (!("scope" in r)) return;
          file = r.scope.agentsFile;
          kind = "convention";
        }
      }
      appendManaged(
        file,
        kind === "preference" ? "## Preferences" : "## Conventions",
        input,
      );
      if (hint?.command === "/nb:remember") setHint(undefined);
      invalidate();
      ctx.ui.notify(`✓ Saved ${kind}: ${oneLine(input)}`, "info");
      refreshStatus(ctx);
    },
  });

  pi.registerCommand("nb:prefs", {
    description: "Edit saved preferences or project conventions by hand",
    handler: async (_args, ctx) => {
      const { project, scope, global } = locate(ctx.cwd);
      let file = global.agentsFile;
      let heading = "## Preferences";
      if (scope && project) {
        const PREF = "Preferences (everywhere)";
        const CONV = `Conventions (${project.name})`;
        const choice = await ctx.ui.select("◆ Edit", [PREF, CONV]);
        if (!choice) return;
        if (choice === CONV) {
          file = scope.agentsFile;
          heading = "## Conventions";
        }
      }
      const current = readManaged(file);
      const edited = await ctx.ui.editor(
        `◆ ${heading.slice(3)}, one per line`,
        current.join("\n"),
      );
      if (edited === undefined) return;
      const lines = edited
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
      const secret = findSecret(lines.join("\n"));
      if (secret) {
        ctx.ui.notify(
          `Not saved: looks like it contains a ${secret}.`,
          "error",
        );
        return;
      }
      replaceManaged(file, heading, lines);
      invalidate();
      ctx.ui.notify(
        `✓ Saved ${lines.length} ${heading.slice(3).toLowerCase()}`,
        "info",
      );
      refreshStatus(ctx);
    },
  });

  pi.registerCommand("nb:wrap", {
    description:
      "Ask the model to record decisions, lessons and the handoff from this session",
    handler: async (_args, ctx) => {
      const { scope } = locate(ctx.cwd);
      sendOwnPrompt(ctx, wrapPrompt(!!scope));
    },
  });

  pi.registerCommand("nb:curate", {
    description:
      "Ask the model to merge duplicates and retire stale notebook entries",
    handler: async (_args, ctx) => {
      const { project, scope, global } = locate(ctx.cwd);
      const scopes = [scope, global].filter((s): s is Scope => !!s);
      if (scopes.every((s) => listAll(s).length === 0)) {
        ctx.ui.notify("Nothing to curate yet.", "info");
        return;
      }
      const state = loadState();
      for (const s of scopes) state.curated[s.dir] = listAll(s).length;
      saveState(state);
      const skillDirs = [
        ...(project ? [join(project.root, ".pi", "skills")] : []),
        join(agentDir(), "skills"),
      ];
      sendOwnPrompt(ctx, curatePrompt(skillDirs));
    },
  });
}
