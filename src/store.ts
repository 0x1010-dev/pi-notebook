import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Scope, ScopeKind } from "./paths.ts";

export type EntryKind = "decision" | "lesson";
export type EntryStatus = "active" | "superseded";

export interface Entry {
  scope: ScopeKind;
  kind: EntryKind;
  id: number;
  title: string;
  status: EntryStatus;
  date: string;
  supersedes?: number[];
  supersededBy?: number;
  body: string;
  path: string;
}

const DIRS: Record<EntryKind, string> = {
  decision: "decisions",
  lesson: "lessons",
};
const PREFIX: Record<EntryKind, string> = { decision: "D", lesson: "L" };
const FILE_RE = /^(\d+)-.*\.md$/;

export function ref(e: Pick<Entry, "scope" | "kind" | "id">): string {
  return `${e.scope === "global" ? "~" : ""}${PREFIX[e.kind]}${e.id}`;
}

export function parseRef(
  text: string,
): { global: boolean; kind: EntryKind; id: number } | undefined {
  const m = /^(~?)([DL])(\d+)$/i.exec(text.trim());
  if (!m) return undefined;
  return {
    global: m[1] === "~",
    kind: m[2].toUpperCase() === "D" ? "decision" : "lesson",
    id: Number(m[3]),
  };
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "entry"
  );
}

export function today(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parseFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(
    text.replace(/\r\n/g, "\n"),
  );
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function renderFrontmatter(
  meta: Record<string, string | number | undefined>,
  body: string,
): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.trim()}\n`;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeEntry(e: Entry): void {
  writeFile(
    e.path,
    renderFrontmatter(
      {
        id: e.id,
        kind: e.kind,
        title: e.title,
        status: e.status,
        date: e.date,
        supersedes: e.supersedes?.join(", "),
        superseded_by: e.supersededBy,
      },
      e.body,
    ),
  );
}

export function listEntries(scope: Scope, kind: EntryKind): Entry[] {
  const dir = join(scope.dir, DIRS[kind]);
  if (!existsSync(dir)) return [];
  const entries: Entry[] = [];
  for (const name of readdirSync(dir)) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
    entries.push({
      scope: scope.kind,
      kind,
      id: Number(meta.id ?? m[1]),
      title: meta.title || name,
      status: meta.status === "superseded" ? "superseded" : "active",
      date: meta.date ?? "",
      supersedes: meta.supersedes
        ? meta.supersedes
            .split(",")
            .map(Number)
            .filter((n) => !Number.isNaN(n))
        : undefined,
      supersededBy: meta.superseded_by ? Number(meta.superseded_by) : undefined,
      body,
      path,
    });
  }
  return entries.sort((a, b) => a.id - b.id);
}

export function listAll(scope: Scope): Entry[] {
  return [...listEntries(scope, "decision"), ...listEntries(scope, "lesson")];
}

export function getEntry(
  scope: Scope,
  kind: EntryKind,
  id: number,
): Entry | undefined {
  return listEntries(scope, kind).find((e) => e.id === id);
}

export function saveEntry(
  scope: Scope,
  kind: EntryKind,
  title: string,
  body: string,
  supersedes: number[] = [],
  now = new Date(),
): Entry {
  const existing = listEntries(scope, kind);
  const old = supersedes.map((n) => {
    const hit = existing.find((e) => e.id === n);
    if (!hit) throw new Error(`${ref({ scope: scope.kind, kind, id: n })} not found`);
    return hit;
  });
  const id = existing.reduce((max, e) => Math.max(max, e.id), 0) + 1;
  const cleanTitle = oneLine(title);
  const entry: Entry = {
    scope: scope.kind,
    kind,
    id,
    title: cleanTitle,
    status: "active",
    date: today(now),
    supersedes: supersedes.length ? supersedes : undefined,
    body: body.trim() || cleanTitle,
    path: join(
      scope.dir,
      DIRS[kind],
      `${String(id).padStart(4, "0")}-${slugify(cleanTitle)}.md`,
    ),
  };
  writeEntry(entry);
  for (const o of old) writeEntry({ ...o, status: "superseded", supersededBy: id });
  return entry;
}

export interface SearchHit {
  entry: Entry;
  score: number;
  /** Distinct query terms found in the title. */
  titleHits: number;
  snippet: string;
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its just let me my no not of on or our please should so some than that the their them then there these they this to too us use using was we what when where which while who why will with would you your".split(
    " ",
  ),
);

export function keywords(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((t) => t.length > 1 && !STOPWORDS.has(t)),
    ),
  ];
}

export function searchEntries(
  scopes: Scope[],
  query: string,
  limit = 8,
): SearchHit[] {
  const terms = keywords(query);
  if (terms.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const scope of scopes) {
    for (const entry of listAll(scope)) {
      const title = entry.title.toLowerCase();
      const body = entry.body.toLowerCase();
      let score = 0;
      let titleHits = 0;
      for (const t of terms) {
        if (title.includes(t)) {
          score += 3;
          titleHits++;
        }
        if (body.includes(t)) score += 1;
      }
      if (score === 0) continue;
      if (entry.status === "superseded") score *= 0.3;
      hits.push({ entry, score, titleHits, snippet: snippetFor(entry.body, terms) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Active entries strongly related to a prompt; cheap enough to run every turn. */
export function recall(scopes: Scope[], prompt: string, limit: number): Entry[] {
  if (limit <= 0) return [];
  return searchEntries(scopes, prompt, limit * 3)
    .filter((h) => h.entry.status === "active" && h.titleHits >= 1 && h.score >= 5)
    .slice(0, limit)
    .map((h) => h.entry);
}

/** Active entry whose title shares most of its keywords with `title`. */
export function findSimilar(
  scope: Scope,
  kind: EntryKind,
  title: string,
  threshold = 0.6,
): Entry | undefined {
  const a = new Set(keywords(title));
  if (a.size === 0) return undefined;
  let best: { entry: Entry; sim: number } | undefined;
  for (const entry of listEntries(scope, kind)) {
    if (entry.status !== "active") continue;
    const b = new Set(keywords(entry.title));
    const shared = [...a].filter((t) => b.has(t)).length;
    const sim = shared / (a.size + b.size - shared);
    if (sim >= threshold && (!best || sim > best.sim)) best = { entry, sim };
  }
  return best?.entry;
}

function snippetFor(body: string, terms: string[]): string {
  const flat = oneLine(body);
  const lower = flat.toLowerCase();
  const at =
    terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 60);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + 200)}${start + 200 < flat.length ? "…" : ""}`;
}

// AGENTS.md managed section

export const MANAGED_START = "<!-- pi-notebook:start -->";
export const MANAGED_END = "<!-- pi-notebook:end -->";
const START = MANAGED_START;
const END = MANAGED_END;
const NOTICE =
  "<!-- Managed by pi-notebook. Change with /nb:remember, /nb:prefs or the memory_save tool. -->";

export function readManaged(file: string): string[] {
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < s) return [];
  return src
    .slice(s + START.length, e)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2));
}

export function appendManaged(
  file: string,
  heading: string,
  text: string,
): void {
  const line = `- ${oneLine(text)}`;
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  let out: string;
  if (s >= 0 && e > s) {
    out = `${src.slice(0, e).replace(/\n*$/, "\n")}${line}\n${src.slice(e)}`;
  } else {
    const prefix = src.trim() ? src.replace(/\n*$/, "\n\n") : "";
    out = `${prefix}${heading}\n\n${START}\n${NOTICE}\n${line}\n${END}\n`;
  }
  writeFile(file, out);
}

/** Replace every managed line, creating the section only when there is something to write. */
export function replaceManaged(file: string, heading: string, lines: string[]): void {
  const clean = lines.map(oneLine).filter(Boolean);
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const s = src.indexOf(START);
  const e = src.indexOf(END);
  if (s < 0 || e < s) {
    for (const l of clean) appendManaged(file, heading, l);
    return;
  }
  const inner = [NOTICE, ...clean.map((l) => `- ${l}`)].join("\n");
  writeFile(file, `${src.slice(0, s)}${START}\n${inner}\n${src.slice(e)}`);
}

// Handoff

export interface Handoff {
  goal: string;
  status: string;
  nextSteps: string[];
  blockers: string[];
  notes: string;
  /** Written by the todo bridge, not the model. */
  todos: string[];
  updated: string;
}

const HANDOFF_SECTIONS: [keyof Handoff, string][] = [
  ["goal", "Goal"],
  ["status", "Status"],
  ["nextSteps", "Next steps"],
  ["blockers", "Blockers"],
  ["notes", "Notes"],
  ["todos", "Open todos"],
];

export function handoffPath(scope: Scope): string {
  return join(scope.dir, "handoff.md");
}

export function readHandoff(scope: Scope): Handoff | undefined {
  const path = handoffPath(scope);
  if (!existsSync(path)) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
  const h: Handoff = {
    goal: "",
    status: "",
    nextSteps: [],
    blockers: [],
    notes: "",
    todos: [],
    updated: meta.updated ?? "",
  };
  const parts = body.split(/^## /m).slice(1);
  for (const part of parts) {
    const nl = part.indexOf("\n");
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const content = nl < 0 ? "" : part.slice(nl + 1).trim();
    const key = HANDOFF_SECTIONS.find(([, t]) => t === title)?.[0];
    if (!key) continue;
    if (key === "nextSteps" || key === "blockers" || key === "todos") {
      h[key] = content
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    } else if (key !== "updated") {
      h[key] = content;
    }
  }
  return h;
}

export function writeHandoff(scope: Scope, h: Handoff): void {
  const sections: string[] = [];
  for (const [key, title] of HANDOFF_SECTIONS) {
    const value = h[key];
    if (Array.isArray(value)) {
      if (value.length)
        sections.push(
          `## ${title}\n\n${value.map((v) => `- ${oneLine(v)}`).join("\n")}`,
        );
    } else if (value.trim()) {
      sections.push(`## ${title}\n\n${value.trim()}`);
    }
  }
  writeFile(
    handoffPath(scope),
    renderFrontmatter({ updated: h.updated }, sections.join("\n\n")),
  );
}

export function initScope(scope: Scope): void {
  mkdirSync(join(scope.dir, DIRS.decision), { recursive: true });
  mkdirSync(join(scope.dir, DIRS.lesson), { recursive: true });
  const ignore = join(scope.dir, ".gitignore");
  if (scope.mode === "repo" && !existsSync(ignore))
    writeFileSync(ignore, "handoff.md\n");
}
