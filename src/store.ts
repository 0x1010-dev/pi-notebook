import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Scope, ScopeKind } from "./paths.ts";
import { staleness } from "./git.ts";

export interface Entry {
  scope: ScopeKind;
  id: number;
  title: string;
  status: "active" | "retired";
  date: string;
  tags: string[];
  files?: string[];
  commit?: string;
  retiredReason?: string;
  body: string;
  path: string;
}

export function ref(e: Pick<Entry, "scope" | "id">): string {
  return `${e.scope === "global" ? "~" : ""}M${e.id}`;
}

export function parseRef(text: string): { global: boolean; id: number } | undefined {
  const m = /^(~?)M([1-9]\d*)$/i.exec(text.trim());
  if (!m || !Number.isSafeInteger(Number(m[2]))) return undefined;
  return { global: m[1] === "~", id: Number(m[2]) };
}

export function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "memory";
}

export function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim().replace(/^#+/, "").toLowerCase()
    .replace(/[^\p{L}\p{N}_.+/-]+/gu, "-").replace(/^-+|-+$/g, "")).filter(Boolean))];
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2].trim() };
}

function renderFrontmatter(meta: Record<string, string | undefined>, body: string): string {
  const lines = Object.entries(meta).filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${v}`);
  return `${lines.length ? `---\n${lines.join("\n")}\n---\n\n` : ""}${body.trim()}\n`;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function stringList(value: string | undefined, field: string, path: string): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string"))
    throw new Error(`Invalid ${field} in ${path}: expected a JSON string array.`);
  return parsed;
}

function writeEntry(e: Entry): void {
  writeFile(e.path, renderFrontmatter({
    updated: e.date,
    tags: e.tags.length ? JSON.stringify(e.tags) : undefined,
    files: e.files?.length ? JSON.stringify(e.files) : undefined,
    commit: e.commit,
    retired_reason: e.retiredReason ? JSON.stringify(e.retiredReason) : undefined,
  }, `# ${e.title}\n\n${e.body}`));
}

export function listAll(scope: Scope): Entry[] {
  const entries: Entry[] = [];
  for (const status of ["active", "retired"] as const) {
    const dir = join(scope.dir, status === "active" ? "memories" : "archive");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      const m = /^(\d+)-.*\.md$/.exec(name);
      if (!m) continue;
      const path = join(dir, name);
      const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
      const heading = /^# ([^\n]+)\n?([\s\S]*)$/.exec(body);
      const id = Number(m[1]);
      if (!heading || !heading[1].trim() || !Number.isSafeInteger(id) || id < 1)
        throw new Error(`Invalid memory ${path}: expected a numeric filename and a # title.`);
      if (entries.some((e) => e.id === id))
        throw new Error(`Duplicate memory ID M${id} in ${scope.dir}.`);
      const retiredReason: unknown = meta.retired_reason ? JSON.parse(meta.retired_reason) : undefined;
      if (retiredReason !== undefined && typeof retiredReason !== "string")
        throw new Error(`Invalid retired_reason in ${path}: expected a string.`);
      entries.push({
        scope: scope.kind, id, status, path,
        title: heading[1].trim(), body: heading[2].trim(),
        date: meta.updated ?? "",
        tags: normalizeTags(stringList(meta.tags, "tags", path)),
        files: stringList(meta.files, "files", path),
        commit: meta.commit,
        retiredReason,
      });
    }
  }
  return entries.sort((a, b) => a.id - b.id);
}

export function getEntry(scope: Scope, id: number): Entry | undefined {
  return listAll(scope).find((e) => e.id === id);
}

export interface MemoryMeta {
  tags?: string[];
  files?: string[];
  commit?: string;
}

export function saveEntry(
  scope: Scope, title: string, body: string, meta: MemoryMeta = {}, now = new Date(),
): Entry {
  if (!title.trim() || !body.trim()) throw new Error("A memory needs a title and content.");
  const id = listAll(scope).reduce((max, e) => Math.max(max, e.id), 0) + 1;
  const cleanTitle = oneLine(title);
  const entry: Entry = {
    scope: scope.kind, id, title: cleanTitle, body: body.trim(),
    status: "active", date: now.toISOString(), tags: normalizeTags(meta.tags ?? []),
    files: meta.files, commit: meta.commit,
    path: join(scope.dir, "memories", `${String(id).padStart(4, "0")}-${slugify(cleanTitle)}.md`),
  };
  writeEntry(entry);
  refreshIndex(scope);
  return entry;
}

export function updateEntry(
  scope: Scope, id: number,
  patch: MemoryMeta & { title?: string; body?: string }, now = new Date(),
): Entry {
  const entry = getEntry(scope, id);
  if (!entry) throw new Error(`M${id} not found.`);
  if (entry.status !== "active") throw new Error(`M${id} is retired; save a new memory instead.`);
  if (patch.title !== undefined && !patch.title.trim() ||
      patch.body !== undefined && !patch.body.trim())
    throw new Error("A memory needs a title and content.");
  const updated: Entry = {
    ...entry,
    title: patch.title === undefined ? entry.title : oneLine(patch.title),
    body: patch.body === undefined ? entry.body : patch.body.trim(),
    tags: patch.tags === undefined ? entry.tags : normalizeTags(patch.tags),
    files: patch.files ?? entry.files,
    commit: patch.commit ?? entry.commit,
    date: now.toISOString(),
  };
  writeEntry(updated);
  refreshIndex(scope);
  return updated;
}

export function retireEntry(scope: Scope, id: number, reason: string): void {
  const entry = getEntry(scope, id);
  if (!entry) throw new Error(`M${id} not found.`);
  if (entry.status === "retired") return;
  const archived = { ...entry, status: "retired" as const, retiredReason: oneLine(reason) };
  writeEntry(archived);
  const target = join(scope.dir, "archive", entry.path.slice(entry.path.lastIndexOf("/") + 1));
  mkdirSync(dirname(target), { recursive: true });
  renameSync(entry.path, target);
  refreshIndex(scope);
}

export function revision(e: Entry): string {
  return createHash("sha1").update(JSON.stringify([
    e.path, e.title, e.body, e.tags, e.files, e.commit, e.status,
  ])).digest("hex");
}

export function preview(e: Pick<Entry, "body">, max = 240): string {
  const first = e.body.trim().split(/\n\s*\n/)[0] ?? "";
  const flat = oneLine(first);
  if (flat.length <= max) return flat;
  const end = flat.lastIndexOf(" ", max - 3);
  return `${flat.slice(0, end > max / 2 ? end : max - 3)}...`;
}

function markdownText(text: string): string {
  return oneLine(text).replace(/([\\`*_[\]<>#!|])/g, "\\$1");
}

export function refreshIndex(scope: Scope): void {
  if (!existsSync(scope.dir)) return;
  const entries = listAll(scope).filter((e) => e.status === "active");
  const lines = ["# Notebook", "", "Durable knowledge for future work. Edit memory files freely; this index is generated.", ""];
  if (existsSync(handoffPath(scope))) lines.push("[Current handoff](handoff.md)", "");
  if (!entries.length) lines.push("No memories yet.");
  for (const e of entries) {
    const link = relative(scope.dir, e.path).split("/").map(encodeURIComponent).join("/");
    lines.push(`## [${ref(e)}: ${markdownText(e.title)}](${link})`, "", markdownText(preview(e)), "");
    if (e.tags.length) lines.push(e.tags.map((t) => `#${markdownText(t)}`).join(" "), "");
    if (e.files?.length) {
      const paths = e.files.map((f) => {
        if (!scope.project) return `\`${f}\``;
        const target = relative(scope.dir, join(scope.project.root, f))
          .split("/").map(encodeURIComponent).join("/");
        return `[${markdownText(f)}](${target})`;
      });
      lines.push(`Related: ${paths.join(", ")}`, "");
    }
    if (scope.project && e.commit) {
      const warning = staleness(scope.project.root, e.commit, e.files);
      if (warning) lines.push(`> ${markdownText(warning)}`, "");
    }
  }
  const content = `${lines.join("\n").trim()}\n`;
  const path = join(scope.dir, "README.md");
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeFile(path, content);
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its just let me my no not of on or our please should so some than that the their them then there these they this to too us use using was we what when where which while who why will with would you your".split(" "),
);

export function keywords(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t))];
}

export interface SearchHit {
  entry: Entry;
  score: number;
  snippet: string;
  matches: string[];
}

interface SearchOptions {
  includeRetired?: boolean;
  exclude?: (entry: Entry) => boolean;
}

export function searchEntries(
  scopes: Scope[], query: string, limit = 8, options: SearchOptions = {},
): SearchHit[] {
  const tags = normalizeTags([...query.matchAll(/(?:^|\s)#([\p{L}\p{N}_.+/-]+)/gu)].map((m) => m[1]));
  const terms = keywords(query.replace(/(?:^|\s)#[\p{L}\p{N}_.+/-]+/gu, " "));
  const paths = [...query.matchAll(/(?:^|\s)(\.?\/?[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+)/gu)]
    .map((m) => m[1].replace(/^\.\//, "").toLowerCase());
  if ((!terms.length && !tags.length) || !Number.isFinite(limit) || limit <= 0) return [];
  const entries = scopes.flatMap(listAll).filter((e) =>
    (options.includeRetired || e.status === "active") &&
    !options.exclude?.(e) && tags.every((t) => e.tags.includes(t)));
  const documents = entries.map((entry) => ({
    entry,
    fields: [
      { name: "title", weight: 3, tokens: new Set(keywords(entry.title)) },
      { name: "tags", weight: 4, tokens: new Set(keywords(entry.tags.join(" "))) },
      { name: "paths", weight: 3, tokens: new Set(keywords((entry.files ?? []).join(" "))) },
      { name: "content", weight: 1, tokens: new Set(keywords(entry.body)) },
    ],
  }));
  const rarity = new Map(terms.map((t) => [t, 1 + Math.log(1 + documents.length /
    (1 + documents.filter((d) => d.fields.some((f) => f.tokens.has(t))).length))]));
  const hits: SearchHit[] = [];
  for (const { entry, fields } of documents) {
    let score = tags.length * 4;
    const matches = new Set<string>(tags.map((t) => `#${t}`));
    for (const path of paths) {
      const related = entry.files?.some((file) => {
        const normalized = file.replace(/^\.\//, "").replace(/\/$/, "").toLowerCase();
        return normalized === path || path.startsWith(`${normalized}/`) ||
          normalized.startsWith(`${path}/`);
      });
      if (related || entry.body.toLowerCase().includes(path)) {
        score += 10;
        matches.add(`file:${path}`);
      }
    }
    for (const term of terms) {
      const found = fields.filter((f) => f.tokens.has(term));
      if (!found.length) continue;
      score += Math.max(...found.map((f) => f.weight)) * rarity.get(term)!;
      for (const f of found) matches.add(`${f.name}:${term}`);
    }
    if (!matches.size) continue;
    if (entry.status === "retired") score *= 0.3;
    hits.push({ entry, score, matches: [...matches], snippet: preview(entry) });
  }
  return hits.sort((a, b) => b.score - a.score ||
    b.entry.date.localeCompare(a.entry.date) || ref(a.entry).localeCompare(ref(b.entry)))
    .slice(0, Math.floor(limit));
}

export function recall(
  scopes: Scope[], prompt: string, limit: number,
  exclude?: (entry: Entry) => boolean,
): Entry[] {
  const hits = searchEntries(scopes, prompt, Number.MAX_SAFE_INTEGER, { exclude });
  const terms = keywords(prompt);
  const directPathHit = hits.some((h) => h.matches.some((m) => m.startsWith("file:")));
  return hits.filter((h) => {
    if (directPathHit) return h.matches.some((m) => m.startsWith("file:"));
    if (h.matches.some((m) => m.startsWith("#"))) return true;
    const contentOnly = h.matches.every((m) => m.startsWith("content:"));
    const matched = new Set(h.matches.map((m) => m.slice(m.indexOf(":") + 1))).size;
    return contentOnly ? matched >= 2 : matched >= Math.min(2, terms.length);
  }).slice(0, Math.max(0, Math.floor(limit))).map((h) => h.entry);
}

export const MANAGED_START = "<!-- pi-notebook:start -->";
export const MANAGED_END = "<!-- pi-notebook:end -->";
export type RuleKind = "preference" | "convention";
export const RULE_HEADING: Record<RuleKind, string> = {
  preference: "## Preferences", convention: "## Conventions",
};

export function readManaged(file: string): string[] {
  if (!existsSync(file)) return [];
  const src = readFileSync(file, "utf8");
  const s = src.indexOf(MANAGED_START), e = src.indexOf(MANAGED_END);
  if (s < 0 || e < s) return [];
  return src.slice(s + MANAGED_START.length, e).split("\n")
    .map((l) => l.trim()).filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
}

export function appendManaged(file: string, heading: string, text: string): boolean {
  const lines = readManaged(file);
  if (lines.includes(oneLine(text))) return false;
  replaceManaged(file, heading, [...lines, oneLine(text)]);
  return true;
}

export function replaceManaged(file: string, heading: string, lines: string[]): void {
  const clean = lines.map(oneLine).filter(Boolean);
  const src = existsSync(file) ? readFileSync(file, "utf8") : "";
  const s = src.indexOf(MANAGED_START), e = src.indexOf(MANAGED_END);
  const block = [MANAGED_START,
    "<!-- Managed by pi-notebook. Edit with /nb:remember or /nb:prefs. -->",
    ...clean.map((l) => `- ${l}`), MANAGED_END].join("\n");
  if (s >= 0 && e > s)
    writeFile(file, `${src.slice(0, s)}${block}${src.slice(e + MANAGED_END.length)}`);
  else if (clean.length)
    writeFile(file, `${src.trimEnd()}${src.trim() ? "\n\n" : ""}${heading}\n\n${block}\n`);
}

export interface Handoff {
  goal: string;
  status: string;
  nextSteps: string[];
  blockers: string[];
  notes: string;
  updated: string;
}

const HANDOFF_SECTIONS: [keyof Handoff, string][] = [
  ["goal", "Goal"], ["status", "Status"], ["nextSteps", "Next actions"],
  ["blockers", "Blockers"], ["notes", "Notes"],
];

export function handoffPath(scope: Scope): string {
  return join(scope.dir, "handoff.md");
}

export function readHandoff(scope: Scope): Handoff | undefined {
  if (!existsSync(handoffPath(scope))) return undefined;
  const { meta, body } = parseFrontmatter(readFileSync(handoffPath(scope), "utf8"));
  const h: Handoff = {
    goal: "", status: "", nextSteps: [], blockers: [], notes: "", updated: meta.updated ?? "",
  };
  for (const part of body.split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    const title = (nl < 0 ? part : part.slice(0, nl)).trim();
    const content = nl < 0 ? "" : part.slice(nl + 1).trim();
    const key = HANDOFF_SECTIONS.find(([, t]) => t === title)?.[0];
    if (key === "nextSteps" || key === "blockers")
      h[key] = content.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
    else if (key && key !== "updated") h[key] = content;
  }
  return h;
}

export function writeHandoff(scope: Scope, h: Handoff): void {
  const sections = ["# Current handoff"];
  for (const [key, title] of HANDOFF_SECTIONS) {
    const value = h[key];
    if (Array.isArray(value)) {
      if (value.length) sections.push(`## ${title}\n\n${value.map((v) => `- ${oneLine(v)}`).join("\n")}`);
    } else if (value.trim()) sections.push(`## ${title}\n\n${value.trim()}`);
  }
  writeFile(handoffPath(scope), renderFrontmatter({ updated: h.updated }, sections.join("\n\n")));
  refreshIndex(scope);
}

export function initScope(scope: Scope): void {
  mkdirSync(join(scope.dir, "memories"), { recursive: true });
  if (scope.mode === "repo" && !existsSync(join(scope.dir, ".gitignore")))
    writeFileSync(join(scope.dir, ".gitignore"), "handoff.md\n");
  refreshIndex(scope);
}
