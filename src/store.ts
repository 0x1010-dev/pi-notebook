import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Scope, ScopeKind } from "./paths.ts";
import { parseDocument, stringify } from "yaml";

export interface Entry {
  scope: ScopeKind;
  id: number;
  title: string;
  date: string;
  tags: string[];
  files?: string[];
  commit?: string;
  body: string;
  path: string;
}

export function ref(entry: Pick<Entry, "scope" | "id">): string {
  return `${entry.scope === "global" ? "~" : ""}M${entry.id}`;
}

export function parseRef(
  text: string,
): { global: boolean; id: number } | undefined {
  const match = /^(~?)M([1-9]\d*)$/i.exec(text.trim());
  if (!match || !Number.isSafeInteger(Number(match[2]))) {
    return undefined;
  }
  return { global: match[1] === "~", id: Number(match[2]) };
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
      .slice(0, 60)
      .replace(/-+$/, "") || "memory"
  );
}

export function normalizeTags(tags: string[]): string[] {
  return [
    ...new Set(
      tags
        .map((t) =>
          t
            .trim()
            .replace(/^#+/, "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}_.+/-]+/gu, "-")
            .replace(/^-+|-+$/g, ""),
        )
        .filter(Boolean),
    ),
  ];
}

function parseFrontmatter(text: string): {
  meta: Record<string, unknown>;
  body: string;
} {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    if (normalized.startsWith("---\n")) {
      throw new Error("Unclosed metadata block.");
    }
    return { meta: {}, body: normalized.trim() };
  }
  const document = parseDocument(match[1], {
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length) {
    throw new Error(document.errors.map((error) => error.message).join("; "));
  }
  const meta: unknown = document.toJS({ maxAliasCount: 0 });
  if (meta === null) {
    return { meta: {}, body: match[2].trim() };
  }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error("Metadata must be a YAML mapping.");
  }
  return {
    meta: Object.fromEntries(Object.entries(meta)),
    body: match[2].trim(),
  };
}

function renderFrontmatter(
  meta: Record<string, string | string[] | undefined>,
  body: string,
): string {
  const fields = Object.entries(meta).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  return `${fields.length ? `---\n${stringify(Object.fromEntries(fields))}---\n\n` : ""}${body.trim()}\n`;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function stringList(value: unknown, field: string, path: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new Error(
      `Invalid ${field} in ${path}: expected a YAML list of strings.`,
    );
  }
  return value;
}

function scalar(value: unknown, field: string): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid ${field}: expected text.`);
  }
  return value;
}

export interface MemoryDiagnostic {
  path: string;
  reason: string;
}

export interface MemoryCollection {
  entries: Entry[];
  diagnostics: MemoryDiagnostic[];
  maxId: number;
}

export function diagnosticText(diagnostics: MemoryDiagnostic[]): string {
  return diagnostics.length
    ? `Notebook files need repair (excluded from recall):\n${diagnostics.map((d) => `- ${d.path}: ${d.reason}`).join("\n")}`
    : "";
}

function writeEntry(entry: Entry): void {
  atomicWrite(
    entry.path,
    renderFrontmatter(
      {
        updated: entry.date,
        tags: entry.tags.length ? entry.tags : undefined,
        files: entry.files?.length ? entry.files : undefined,
        commit: entry.commit,
      },
      `# ${entry.title}\n\n${entry.body}`,
    ),
  );
}

export function listAll(scope: Scope): Entry[] {
  return loadMemories(scope).entries;
}

export function loadMemories(scope: Scope): MemoryCollection {
  const entries: Entry[] = [];
  const diagnostics: MemoryDiagnostic[] = [];
  const ids = new Map<number, string[]>();
  let maxId = 0;
  const dir = join(scope.dir, "memories");
  if (!existsSync(dir)) {
    return { entries, diagnostics, maxId };
  }
  const names = readdirSync(dir).sort();
  for (const name of names) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const match = /^(\d+)/.exec(name);
    if (!match) {
      continue;
    }
    const id = Number(match[1]);
    if (Number.isSafeInteger(id) && id > 0) {
      maxId = Math.max(maxId, id);
      ids.set(id, [...(ids.get(id) ?? []), name]);
    }
  }
  for (const name of names) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const match = /^(\d+)-.*\.md$/.exec(name);
    const path = join(dir, name);
    try {
      if (!match) {
        throw new Error("Expected a numeric filename such as 0001-topic.md.");
      }
      const id = Number(match[1]);
      if ((ids.get(id)?.length ?? 0) > 1) {
        throw new Error(
          `Duplicate memory ID M${id}; repair all files with this ID.`,
        );
      }
      const { meta, body } = parseFrontmatter(readFileSync(path, "utf8"));
      const heading = /^# ([^\n]+)\n?([\s\S]*)$/.exec(body);
      if (
        !heading ||
        !heading[1].trim() ||
        !Number.isSafeInteger(id) ||
        id < 1
      ) {
        throw new Error(
          `Invalid memory ${path}: expected a numeric filename and a # title.`,
        );
      }
      entries.push({
        scope: scope.kind,
        id,
        path,
        title: heading[1].trim(),
        body: heading[2].trim(),
        date: scalar(meta.updated, "updated"),
        tags: normalizeTags(stringList(meta.tags, "tags", path)),
        files: stringList(meta.files, "files", path),
        commit: scalar(meta.commit, "commit") || undefined,
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
      diagnostics.push({ path, reason: error.message });
    }
  }
  return { entries: entries.sort((a, b) => a.id - b.id), diagnostics, maxId };
}

function reserveId(
  scope: Scope,
  allocate = true,
  collection = loadMemories(scope),
): number {
  const path = join(scope.dir, ".next-id");
  const next = existsSync(path) ? Number(readFileSync(path, "utf8").trim()) : 1;
  if (!Number.isSafeInteger(next) || next < 1) {
    throw new Error(`Invalid memory ID counter: ${path}`);
  }
  const id = Math.max(next, collection.maxId + 1);
  if (!Number.isSafeInteger(id + 1)) {
    throw new Error("Memory ID counter exhausted.");
  }
  writeFile(path, `${allocate ? id + 1 : id}\n`);
  return id;
}

export function getEntry(
  scope: Scope,
  id: number,
  loaded = loadMemories(scope),
): Entry | undefined {
  const invalid = loaded.diagnostics.filter(
    (d) => Number(/^(\d+)/.exec(d.path.split("/").at(-1) ?? "")?.[1]) === id,
  );
  if (invalid.length) {
    throw new Error(diagnosticText(invalid));
  }
  return loaded.entries.find((entry) => entry.id === id);
}

export interface MemoryMeta {
  tags?: string[];
  files?: string[];
  commit?: string;
}

export function saveEntry(
  scope: Scope,
  title: string,
  body: string,
  meta: MemoryMeta = {},
  now = new Date(),
  collection = loadMemories(scope),
): Entry {
  if (!title.trim() || !body.trim()) {
    throw new Error("A memory needs a title and content.");
  }
  const id = reserveId(scope, true, collection);
  const cleanTitle = oneLine(title);
  const entry: Entry = {
    scope: scope.kind,
    id,
    title: cleanTitle,
    body: body.trim(),
    date: now.toISOString(),
    tags: normalizeTags(meta.tags ?? []),
    files: meta.files,
    commit: meta.commit,
    path: join(
      scope.dir,
      "memories",
      `${String(id).padStart(4, "0")}-${slugify(cleanTitle)}.md`,
    ),
  };
  writeEntry(entry);
  collection.entries.push(entry);
  collection.maxId = id;
  refreshIndex(scope, collection);
  return entry;
}

export function updateEntry(
  scope: Scope,
  id: number,
  patch: MemoryMeta & { title?: string; body?: string },
  now = new Date(),
  collection = loadMemories(scope),
): Entry {
  const entry = getEntry(scope, id, collection);
  if (!entry) {
    throw new Error(`M${id} not found.`);
  }
  if (
    (patch.title !== undefined && !patch.title.trim()) ||
    (patch.body !== undefined && !patch.body.trim())
  ) {
    throw new Error("A memory needs a title and content.");
  }
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
  collection.entries.splice(collection.entries.indexOf(entry), 1, updated);
  refreshIndex(scope, collection);
  return updated;
}

export function deleteEntry(scope: Scope, id: number): void {
  const entry = getEntry(scope, id);
  if (!entry) {
    throw new Error(`M${id} not found.`);
  }
  // Reserve above every existing ID before removing a file, including converted notebooks.
  reserveId(scope, false);
  unlinkSync(entry.path);
  refreshIndex(scope);
}

export function revision(entry: Entry): string {
  return createHash("sha1")
    .update(
      JSON.stringify([
        entry.path,
        entry.title,
        entry.body,
        entry.tags,
        entry.files,
        entry.commit,
      ]),
    )
    .digest("hex");
}

export function preview(entry: Pick<Entry, "body">, max = 240): string {
  const first = entry.body.trim().split(/\n\s*\n/)[0] ?? "";
  const flat = oneLine(first);
  if (flat.length <= max) {
    return flat;
  }
  const end = flat.lastIndexOf(" ", max - 3);
  return `${flat.slice(0, end > max / 2 ? end : max - 3)}...`;
}

export function markdownText(text: string): string {
  return oneLine(text).replace(/([\\`*_[\]<>#!|])/g, "\\$1");
}

export function refreshIndex(
  scope: Scope,
  collection = loadMemories(scope),
): void {
  if (!existsSync(scope.dir)) {
    return;
  }
  const { entries, diagnostics } = collection;
  const lines = [
    "# Notebook",
    "",
    "Durable knowledge for future work. Edit memory files freely; this index is generated.",
    "",
  ];
  if (existsSync(handoffPath(scope))) {
    lines.push("[Current handoff](handoff.md)", "");
  }
  if (!entries.length) {
    lines.push("No memories yet.");
  }
  if (diagnostics.length) {
    lines.push(
      "## Files needing repair",
      "",
      ...diagnostics.map(
        (d) => `- ${markdownText(d.path)}: ${markdownText(d.reason)}`,
      ),
      "",
    );
  }
  for (const entry of entries) {
    const link = relative(scope.dir, entry.path)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    lines.push(
      `## [${ref(entry)}: ${markdownText(entry.title)}](${link})`,
      "",
      markdownText(preview(entry)),
      "",
    );
    if (entry.tags.length) {
      lines.push(entry.tags.map((t) => `#${markdownText(t)}`).join(" "), "");
    }
    if (entry.files?.length) {
      const paths = entry.files.map((f) => {
        if (!scope.project) {
          return `\`${f}\``;
        }
        const target = relative(scope.dir, join(scope.project.root, f))
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        return `[${markdownText(f)}](${target})`;
      });
      lines.push(`Related: ${paths.join(", ")}`, "");
    }
    if (entry.commit) {
      lines.push(
        `Code baseline: ${markdownText(entry.commit)} (not verified by this index).`,
        "",
      );
    }
  }
  const content = `${lines.join("\n").trim()}\n`;
  const path = join(scope.dir, "README.md");
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    writeFile(path, content);
  }
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could do does for from had has have how i if in into is it its just let me my no not of on or our please should so some than that the their them then there these they this to too us use using was we what when where which while who why will with would you your".split(
    " ",
  ),
);

export function keywords(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))
        .map((t) =>
          t.length > 3 && t.endsWith("s") && !t.endsWith("ss")
            ? t.slice(0, -1)
            : t,
        ),
    ),
  ];
}

export interface SearchHit {
  entry: Entry;
  score: number;
  snippet: string;
  matches: string[];
}

interface SearchOptions {
  exclude?: (entry: Entry) => boolean;
  entries?: Entry[];
}

export function searchEntries(
  scopes: Scope[],
  query: string,
  limit = 8,
  options: SearchOptions = {},
): SearchHit[] {
  const tags = normalizeTags(
    [...query.matchAll(/(?:^|\s)#([\p{L}\p{N}_.+/-]+)/gu)].map(
      (match) => match[1],
    ),
  );
  const terms = keywords(query.replace(/(?:^|\s)#[\p{L}\p{N}_.+/-]+/gu, " "));
  const paths = [
    ...query.matchAll(
      /(?:^|\s)(\.?\/?[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+)/gu,
    ),
  ].map((match) => match[1].replace(/^\.\//, "").toLowerCase());
  if (
    (!terms.length && !tags.length) ||
    !Number.isFinite(limit) ||
    limit <= 0
  ) {
    return [];
  }
  const entries = (options.entries ?? scopes.flatMap(listAll)).filter(
    (entry) =>
      !options.exclude?.(entry) && tags.every((t) => entry.tags.includes(t)),
  );
  const documents = entries.map((entry) => ({
    entry,
    fields: [
      { name: "title", weight: 3, tokens: new Set(keywords(entry.title)) },
      {
        name: "tags",
        weight: 4,
        tokens: new Set(keywords(entry.tags.join(" "))),
      },
      {
        name: "paths",
        weight: 3,
        tokens: new Set(keywords((entry.files ?? []).join(" "))),
      },
      { name: "content", weight: 1, tokens: new Set(keywords(entry.body)) },
    ],
  }));
  const rarity = new Map<string, number>();
  for (const term of terms) {
    const matchingDocuments = documents.filter((document) =>
      document.fields.some((field) => field.tokens.has(term)),
    ).length;
    const weight = 1 + Math.log(1 + documents.length / (1 + matchingDocuments));
    rarity.set(term, weight);
  }
  const hits: SearchHit[] = [];
  for (const { entry, fields } of documents) {
    let score = tags.length * 4;
    const matches = new Set<string>(tags.map((t) => `#${t}`));
    for (const path of paths) {
      const related = entry.files?.some((file) => {
        const normalized = file
          .replace(/^\.\//, "")
          .replace(/\/$/, "")
          .toLowerCase();
        return (
          normalized === path ||
          path.startsWith(`${normalized}/`) ||
          normalized.startsWith(`${path}/`)
        );
      });
      if (related || entry.body.toLowerCase().includes(path)) {
        score += 10;
        matches.add(`file:${path}`);
      }
    }
    for (const term of terms) {
      const found = fields.filter((field) => field.tokens.has(term));
      if (!found.length) {
        continue;
      }
      score +=
        Math.max(...found.map((field) => field.weight)) * rarity.get(term)!;
      for (const field of found) {
        matches.add(`${field.name}:${term}`);
      }
    }
    if (!matches.size) {
      continue;
    }
    hits.push({ entry, score, matches: [...matches], snippet: preview(entry) });
  }
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.entry.date.localeCompare(a.entry.date) ||
        ref(a.entry).localeCompare(ref(b.entry)),
    )
    .slice(0, Math.floor(limit));
}

export function recall(
  scopes: Scope[],
  prompt: string,
  limit: number,
  exclude?: (entry: Entry) => boolean,
  entries?: Entry[],
): Entry[] {
  const hits = searchEntries(scopes, prompt, Number.MAX_SAFE_INTEGER, {
    exclude,
    entries,
  });
  const terms = keywords(prompt);
  const directPathHit = hits.some((hit) =>
    hit.matches.some((match) => match.startsWith("file:")),
  );
  return hits
    .filter((hit) => {
      if (directPathHit) {
        return hit.matches.some((match) => match.startsWith("file:"));
      }
      if (hit.matches.some((match) => match.startsWith("#"))) {
        return true;
      }
      const contentOnly = hit.matches.every((match) =>
        match.startsWith("content:"),
      );
      const matchedTerms = new Set(
        hit.matches.map((match) => match.slice(match.indexOf(":") + 1)),
      ).size;
      const requiredTerms = contentOnly ? 2 : Math.min(2, terms.length);
      return matchedTerms >= requiredTerms;
    })
    .slice(0, Math.max(0, Math.floor(limit)))
    .map((hit) => hit.entry);
}

export const MANAGED_START = "<!-- pi-notebook:start -->";
export const MANAGED_END = "<!-- pi-notebook:end -->";
export type RuleKind = "preference" | "convention";
export const RULE_HEADING: Record<RuleKind, string> = {
  preference: "## Preferences",
  convention: "## Conventions",
};

export function readManaged(file: string): string[] {
  if (!existsSync(file)) {
    return [];
  }
  const content = readFileSync(file, "utf8");
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if (start < 0 || end < start) {
    return [];
  }
  return content
    .slice(start + MANAGED_START.length, end)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
}

export function appendManaged(
  file: string,
  heading: string,
  text: string,
): boolean {
  const lines = readManaged(file);
  if (lines.includes(oneLine(text))) {
    return false;
  }
  replaceManaged(file, heading, [...lines, oneLine(text)]);
  return true;
}

export function replaceManaged(
  file: string,
  heading: string,
  lines: string[],
): void {
  const clean = lines.map(oneLine).filter(Boolean);
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  const block = [
    MANAGED_START,
    "<!-- Managed by pi-notebook. Edit with /nb:remember or /nb:prefs. -->",
    ...clean.map((line) => `- ${line}`),
    MANAGED_END,
  ].join("\n");
  if (start >= 0 && end > start) {
    writeFile(
      file,
      `${content.slice(0, start)}${block}${content.slice(end + MANAGED_END.length)}`,
    );
  } else if (clean.length) {
    writeFile(
      file,
      `${content.trimEnd()}${content.trim() ? "\n\n" : ""}${heading}\n\n${block}\n`,
    );
  }
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
  ["goal", "Goal"],
  ["status", "Status"],
  ["nextSteps", "Next actions"],
  ["blockers", "Blockers"],
  ["notes", "Notes"],
];

export function handoffPath(scope: Scope): string {
  return join(scope.dir, "handoff.md");
}

function parseHandoff(scope: Scope): Handoff | undefined {
  if (!existsSync(handoffPath(scope))) {
    return undefined;
  }
  const { meta, body } = parseFrontmatter(
    readFileSync(handoffPath(scope), "utf8"),
  );
  const handoff: Handoff = {
    goal: "",
    status: "",
    nextSteps: [],
    blockers: [],
    notes: "",
    updated: scalar(meta.updated, "updated"),
  };
  for (const part of body.split(/^## /m).slice(1)) {
    const newline = part.indexOf("\n");
    const title = (newline < 0 ? part : part.slice(0, newline)).trim();
    const content = newline < 0 ? "" : part.slice(newline + 1).trim();
    const key = HANDOFF_SECTIONS.find(([, t]) => t === title)?.[0];
    if (key === "nextSteps" || key === "blockers") {
      handoff[key] = content
        .split("\n")
        .map((l) => l.replace(/^\s*-\s*/, "").trim())
        .filter(Boolean);
    } else if (key && key !== "updated") {
      handoff[key] = content;
    }
  }
  return handoff;
}

export function loadHandoff(scope: Scope): {
  handoff?: Handoff;
  diagnostics: MemoryDiagnostic[];
} {
  try {
    return { handoff: parseHandoff(scope), diagnostics: [] };
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
    return {
      diagnostics: [{ path: handoffPath(scope), reason: error.message }],
    };
  }
}

export function readHandoff(scope: Scope): Handoff | undefined {
  return loadHandoff(scope).handoff;
}

export function writeHandoff(scope: Scope, handoff: Handoff): void {
  const sections = ["# Current handoff"];
  for (const [key, title] of HANDOFF_SECTIONS) {
    const value = handoff[key];
    if (Array.isArray(value)) {
      if (value.length) {
        sections.push(
          `## ${title}\n\n${value.map((v) => `- ${oneLine(v)}`).join("\n")}`,
        );
      }
    } else if (value.trim()) {
      sections.push(`## ${title}\n\n${value.trim()}`);
    }
  }
  const path = handoffPath(scope);
  ensureHandoffIgnore(scope);
  if (existsSync(path)) {
    atomicWrite(
      join(scope.dir, "handoff.previous.md"),
      readFileSync(path, "utf8"),
    );
  }
  atomicWrite(
    path,
    renderFrontmatter({ updated: handoff.updated }, sections.join("\n\n")),
  );
  refreshIndex(scope);
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function initScope(scope: Scope): void {
  mkdirSync(join(scope.dir, "memories"), { recursive: true });
  ensureHandoffIgnore(scope);
  refreshIndex(scope);
}

function ensureHandoffIgnore(scope: Scope): void {
  if (scope.mode === "repo") {
    const path = join(scope.dir, ".gitignore");
    const current = existsSync(path) ? readFileSync(path, "utf8") : "";
    const missing = [
      "handoff.md",
      "handoff.previous.md",
      "handoff.*.tmp",
    ].filter((line) => !current.split("\n").includes(line));
    if (missing.length) {
      writeFile(
        path,
        `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
      );
    }
  }
}
