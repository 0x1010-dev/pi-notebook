import { Type } from "typebox";
import { entryHead, entryLabel, noteLines } from "../format.ts";
import { formatHandoff } from "../inject.ts";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  type Entry,
  getEntry,
  type Handoff,
  parseRef,
  loadHandoff,
  searchEntries,
  preview,
  refreshIndex,
  loadMemories,
  diagnosticText,
} from "../store.ts";
import { callRow, text, textRow } from "./shared.ts";

export type ParsedQuery =
  | { mode: "all" }
  | { mode: "handoff" }
  | { mode: "refs"; refs: string[] }
  | { mode: "keywords"; words: string[] };

export function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  if (trimmed === "*") return { mode: "all" };
  if (trimmed.toLowerCase() === "handoff") return { mode: "handoff" };
  const tokens = trimmed.split(/[\s,]+/).filter(Boolean);
  if (tokens.length && tokens.every((t) => parseRef(t)))
    return { mode: "refs", refs: tokens };
  return { mode: "keywords", words: tokens };
}

interface SearchOutput {
  content: ReturnType<typeof text>;
  details: { refs: string[] };
}

function readRefs(
  cwd: string,
  words: string[],
  scope: Scope | undefined,
  global: Scope,
): { body: string; refs: string[] } {
  const parsed = words.map(parseRef);
  const found: Entry[] = [];
  const missing: string[] = [];
  parsed.forEach((r, i) => {
    const s = r!.global ? global : scope;
    const e = s ? getEntry(s, r!.id) : undefined;
    if (e) found.push(e);
    else missing.push(words[i]);
  });
  const parts = found.map((e) =>
    [entryHead(e), ...noteLines(cwd, e), "", e.body].join("\n"),
  );
  if (missing.length) parts.push(`Not found: ${missing.join(", ")}`);
  return { body: parts.join("\n\n---\n\n"), refs: found.map(entryLabel) };
}

export function registerMemorySearch(rt: Runtime): void {
  rt.pi.registerTool({
    name: "memory_search",
    label: "Notebook",
    description:
      'Search current durable knowledge or read the handoff. Use keywords (including file paths), #tags, refs like "M3 ~M1" for full memories, "*" to browse, or "handoff".',
    promptSnippet:
      "memory_search: search or list the notebook, read entries by ref, or read the project handoff",
    parameters: Type.Object({
      query: Type.String({
        description: 'Keywords, #tags, file paths, refs like "M3 ~M1", "*", or "handoff"',
      }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Max keyword results, default 8" }),
      ),
    }),

    async execute(_id, p, _signal, _onUpdate, ctx): Promise<SearchOutput> {
      const { scope, global } = locate(ctx.cwd);
      const scopes = scope ? [scope, global] : [global];
      const collections = scopes.map((s) => {
        const loaded = loadMemories(s);
        refreshIndex(s, loaded);
        return loaded;
      });
      const loadedHandoff = scope ? loadHandoff(scope) : undefined;
      const diagnostics = diagnosticText([
        ...collections.flatMap((c) => c.diagnostics), ...(loadedHandoff?.diagnostics ?? []),
      ]);
      const resultText = (body: string) => text([diagnostics, body].filter(Boolean).join("\n\n"));
      const handoff: Handoff | undefined = loadedHandoff?.handoff;
      const handoffRefs = handoff ? [`handoff ${handoff.goal}`] : [];
      const q = parseQuery(p.query);

      if (q.mode === "all") {
        const all = collections.flatMap((c) => c.entries);
        const list = all.length
          ? all.map((e) => `${entryHead(e)}\n  ${e.tags.map((t) => `#${t}`).join(" ")}\n  ${preview(e)}`).join("\n\n")
          : "The notebook is empty.";
        return {
          content: resultText(
            handoff
              ? `Handoff: ${handoff.goal}. Read it with memory_search "handoff".\n\n${list}`
              : list,
          ),
          details: { refs: [...handoffRefs, ...all.map(entryLabel)] },
        };
      }
      if (q.mode === "handoff") {
        if (handoff) rt.session.handoffShown = true;
        return {
          content: resultText(
            handoff
              ? formatHandoff(handoff)
              : "No handoff for this project yet.",
          ),
          details: { refs: handoffRefs },
        };
      }
      if (q.mode === "refs") {
        const read = readRefs(ctx.cwd, q.refs, scope, global);
        return { content: resultText(read.body), details: { refs: read.refs } };
      }

      const hits = searchEntries(scopes, q.words.join(" "), p.limit ?? 8, {
        entries: collections.flatMap((c) => c.entries),
      });
      const body = hits.length
        ? `${hits.map((hit) => [entryHead(hit.entry), ...noteLines(ctx.cwd, hit.entry), hit.snippet, `Matched: ${hit.matches.join(", ")}`].join("\n")).join("\n\n")}\n\nPass refs to read entries in full.`
        : 'No matches. Try other keywords, or "*" to list every entry.';
      return {
        content: resultText(body),
        details: { refs: hits.map((hit) => entryLabel(hit.entry)) },
      };
    },

    renderCall(args, theme) {
      return callRow(theme, "search", theme.fg("dim", `"${args.query ?? ""}"`));
    },

    renderResult(result, { expanded }, theme) {
      const refs =
        (result.details as { refs?: string[] } | undefined)?.refs ?? [];
      if (refs.length === 0) return textRow(theme.fg("dim", "no matches"));
      const shown = expanded ? refs : refs.slice(0, 3);
      const lines = shown.map((r) => {
        const [tag, ...rest] = r.split(" ");
        return `${theme.fg("accent", tag)} ${theme.fg("muted", rest.join(" "))}`;
      });
      if (!expanded && refs.length > 3)
        lines.push(theme.fg("dim", `… ${refs.length - 3} more`));
      return textRow(lines.join("\n"));
    },
  });
}
