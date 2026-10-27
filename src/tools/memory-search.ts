import { Type } from "typebox";
import { entryHead, entryLabel, noteLines } from "../format.ts";
import { formatHandoff } from "../inject.ts";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  type Entry,
  getEntry,
  type Handoff,
  listAll,
  parseRef,
  readHandoff,
  searchEntries,
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
    const e = s ? getEntry(s, r!.kind, r!.id) : undefined;
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
      'Search the notebook or read the project handoff. query is one of: keywords to search; refs like "D3 ~L1 N2" to read entries in full; "*" to list every entry; "handoff" to read where project work stands. Notes read in full say when their code changed since they were saved.',
    promptSnippet:
      "memory_search: search or list the notebook, read entries by ref, or read the project handoff",
    parameters: Type.Object({
      query: Type.String({
        description: 'Keywords, refs like "D3 ~L1", "*", or "handoff"',
      }),
      limit: Type.Optional(
        Type.Number({ description: "Max keyword results, default 8" }),
      ),
    }),

    async execute(_id, p, _signal, _onUpdate, ctx): Promise<SearchOutput> {
      const { scope, global } = locate(ctx.cwd);
      const scopes = scope ? [scope, global] : [global];
      const handoff: Handoff | undefined = scope ? readHandoff(scope) : undefined;
      const handoffRefs = handoff ? [`handoff ${handoff.goal}`] : [];
      const q = parseQuery(p.query);

      if (q.mode === "all") {
        const all = scopes.flatMap((s) => listAll(s));
        const list = all.length
          ? all.map(entryHead).join("\n")
          : "The notebook is empty.";
        return {
          content: text(
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
          content: text(
            handoff ? formatHandoff(handoff) : "No handoff for this project yet.",
          ),
          details: { refs: handoffRefs },
        };
      }
      if (q.mode === "refs") {
        const read = readRefs(ctx.cwd, q.refs, scope, global);
        return { content: text(read.body), details: { refs: read.refs } };
      }

      const hits = searchEntries(scopes, q.words.join(" "), p.limit ?? 8);
      const body = hits.length
        ? `${hits.map((hit) => `${entryHead(hit.entry)}\n  ${hit.snippet}`).join("\n")}\n\nPass refs to read entries in full.`
        : 'No matches. Try other keywords, or "*" to list every entry.';
      return {
        content: text(body),
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
