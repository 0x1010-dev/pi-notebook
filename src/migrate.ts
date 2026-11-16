import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createHash } from "node:crypto";
import type { ScopeKind } from "./paths.ts";
import { markdownText, oneLine, refreshIndex, slugify } from "./store.ts";
import { findSecret } from "./validate.ts";

interface LegacyEntry {
  ref: string;
  source: string;
  original: string;
  meta: Record<string, string>;
  body: string;
}

export interface MigrationOptions {
  source: string;
  scope: ScopeKind;
  rules?: string;
}

export interface MigrationPlan {
  source: string;
  scope: ScopeKind;
  files: { path: string; content: string }[];
  referenceMap: Record<string, string>;
  active: number;
  historical: number;
  warnings: string[];
}

function readRegular(path: string): string {
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(
      `Expected a regular file, not a directory or symlink: ${path}`,
    );
  }
  return readFileSync(path, "utf8");
}

function parseLegacy(
  text: string,
  path: string,
): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(
    text.replace(/\r\n/g, "\n"),
  );
  if (!match) {
    throw new Error(`Missing or malformed legacy frontmatter: ${path}`);
  }
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 1) {
      if (line.trim()) {
        throw new Error(`Unsupported legacy metadata in ${path}: ${line}`);
      }
      continue;
    }
    const key = line.slice(0, colon).trim();
    if (key in meta) {
      throw new Error(`Duplicate metadata ${key} in ${path}`);
    }
    meta[key] = line.slice(colon + 1).trim();
  }
  return { meta, body: match[2].trim() };
}

function references(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?<![\w~])~?[DLN][1-9]\d*\b/gi)].map((match) =>
        match[0].toUpperCase(),
      ),
    ),
  ];
}

function rewriteReferences(text: string, map: Record<string, string>): string {
  return text.replace(
    /(?<![\w~])~?[DLN][1-9]\d*\b/gi,
    (value) => map[value.toUpperCase()] ?? value,
  );
}

/** Read-only planning: no source files are edited and no knowledge is re-verified. */
export function planMigration(options: MigrationOptions): MigrationPlan {
  const source = realpathSync(resolve(options.source));
  if (!lstatSync(source).isDirectory()) {
    throw new Error(`Not a notebook directory: ${source}`);
  }
  const prefix = options.scope === "global" ? "~" : "";
  const entries: LegacyEntry[] = [];
  const files: MigrationPlan["files"] = [];
  const warnings: string[] = [];
  const referenceMap: Record<string, string> = {};
  let legacyDirectories = 0;
  for (const [dir, letter] of [
    ["decisions", "D"],
    ["lessons", "L"],
    ["notes", "N"],
  ] as const) {
    const folder = join(source, dir);
    if (!existsSync(folder)) {
      continue;
    }
    if (
      lstatSync(folder).isSymbolicLink() ||
      !lstatSync(folder).isDirectory()
    ) {
      throw new Error(`Expected a regular legacy directory: ${folder}`);
    }
    legacyDirectories++;
    for (const name of readdirSync(folder).sort()) {
      if (!name.endsWith(".md")) {
        continue;
      }
      const path = join(folder, name);
      const original = readRegular(path);
      const { meta, body } = parseLegacy(original, path);
      const id = Number(meta.id ?? /^(\d+)-/.exec(name)?.[1]);
      if (!Number.isSafeInteger(id) || id < 1 || !meta.title?.trim()) {
        throw new Error(`Invalid legacy ID or title: ${path}`);
      }
      if (
        !["active", "superseded", "retired"].includes(meta.status ?? "active")
      ) {
        throw new Error(`Unknown legacy status in ${path}: ${meta.status}`);
      }
      const ref = `${prefix}${letter}${id}`;
      if (entries.some((entry) => entry.ref === ref)) {
        throw new Error(`Duplicate legacy reference: ${ref}`);
      }
      entries.push({ ref, source: `${dir}/${name}`, original, meta, body });
    }
  }
  if (
    !entries.length &&
    !legacyDirectories &&
    !existsSync(join(source, "handoff.md"))
  ) {
    throw new Error(`No legacy notebook contents found in ${source}`);
  }
  const active = entries.filter(
    (entry) => (entry.meta.status ?? "active") === "active",
  );
  active.forEach((entry, i) => {
    referenceMap[entry.ref] = `${prefix}M${i + 1}`;
  });
  const known = new Map(entries.map((entry) => [entry.ref, entry]));
  const checkReferences = (label: string, text: string) => {
    for (const ref of references(text)) {
      if (referenceMap[ref]) {
        continue;
      }
      const entry = known.get(ref);
      warnings.push(
        `${label}: unresolved ${ref} (${entry ? entry.meta.status : "external or missing"}); inspect the original before removing it.`,
      );
    }
  };
  for (const entry of entries) {
    files.push({ path: `originals/${entry.source}`, content: entry.original });
    if (!referenceMap[entry.ref]) {
      continue;
    }
    checkReferences(entry.ref, `${entry.meta.title}\n${entry.body}`);
    if (!entry.body.trim()) {
      warnings.push(
        `${entry.ref}: content is empty; supply a useful conclusion or omit this memory.`,
      );
    }
    if (findSecret(`${entry.meta.title}\n${entry.body}`)) {
      warnings.push(
        `${entry.ref}: secret-looking content detected; redact it before activation. Originals also retain this content.`,
      );
    }
    if (entry.meta.supersedes || entry.meta.superseded_by) {
      warnings.push(
        `${entry.ref}: has historical replacement metadata; check for partial supersession and still-current knowledge.`,
      );
    }
    if (entry.meta.commit) {
      warnings.push(
        `${entry.ref}: preserved code baseline ${entry.meta.commit}; conversion is not verification.`,
      );
    }
    const related =
      entry.meta.files
        ?.split(",")
        .map((f) => f.trim())
        .filter(Boolean) ?? [];
    if (related.some((f) => isAbsolute(f) || f.split("/").includes(".."))) {
      warnings.push(
        `${entry.ref}: related paths include absolute or parent-relative paths; review before activation.`,
      );
    }
    const metadata = [
      ...(entry.meta.date ? [`updated: ${entry.meta.date}`] : []),
      ...(related.length ? [`files: ${JSON.stringify(related)}`] : []),
      ...(entry.meta.commit ? [`commit: ${entry.meta.commit}`] : []),
    ];
    const title = rewriteReferences(oneLine(entry.meta.title), referenceMap);
    const body = rewriteReferences(entry.body, referenceMap);
    const number = Number(referenceMap[entry.ref].replace(/^~?M/, ""));
    files.push({
      path: `notebook/memories/${String(number).padStart(4, "0")}-${slugify(title)}.md`,
      content: `${metadata.length ? `---\n${metadata.join("\n")}\n---\n\n` : ""}# ${title}\n\n${body}\n`,
    });
  }
  const handoff = join(source, "handoff.md");
  if (existsSync(handoff)) {
    const original = readRegular(handoff);
    const { meta, body } = parseLegacy(original, handoff);
    checkReferences("Handoff", body);
    files.push({ path: "originals/handoff.md", content: original });
    files.push({
      path: "notebook/handoff.md",
      content: `${meta.updated ? `---\nupdated: ${meta.updated}\n---\n\n` : ""}# Current handoff\n\n${rewriteReferences(body, referenceMap).replace(/^## Next steps\s*$/gm, "## Next actions")}\n`,
    });
    warnings.push(
      "Handoff: headings and references converted only; reconcile goal, status and remaining actions before activation.",
    );
  }
  if (options.rules) {
    const content = readRegular(resolve(options.rules));
    files.push({ path: "originals/rules.md", content });
    checkReferences("Rules", content);
    warnings.push(
      "Rules: copied verbatim to originals/rules.md, not installed or rewritten. Review user instructions separately.",
    );
  }
  files.push({
    path: "notebook/.gitignore",
    content: "handoff.md\nhandoff.previous.md\nhandoff.*.tmp\n",
  });
  files.push({
    path: "reference-map.json",
    content: `${JSON.stringify(referenceMap, null, 2)}\n`,
  });
  const provenance = entries.map((entry) => ({
    oldRef: entry.ref,
    newRef: referenceMap[entry.ref] ?? null,
    source: entry.source,
    status: entry.meta.status ?? "active",
    metadata: entry.meta,
    sha256: createHash("sha256").update(entry.original).digest("hex"),
  }));
  files.push({
    path: "provenance.json",
    content: `${JSON.stringify({ source, scope: options.scope, entries: provenance }, null, 2)}\n`,
  });
  const report = [
    "# Notebook conversion review",
    "",
    "**Staging only. No claims were verified, consolidated, corrected or activated.**",
    "",
    `${active.length} active entries converted; ${entries.length - active.length} historical entries retained only under originals/.`,
    "",
    "## Review before activation",
    "",
    "- Back up the entire source notebook and rules independently before replacing anything.",
    "- Review by topic; consolidate complete current accounts and reconcile contradictions.",
    "- Put the actionable conclusion first. Remove speculative explanations and unnecessary history.",
    "- Add optional tags only where useful. Verify related paths against the target repository.",
    "- Keep original code baselines until claims have actually been rechecked.",
    "- Review unresolved references, global knowledge and user rules separately.",
    "- Test representative retrieval queries before installing the staged notebook.",
    "- Do not treat this partial originals snapshot as a backup of all source-directory contents.",
    "",
    "## Reference map",
    "",
    ...active.map(
      (entry) =>
        `- ${entry.ref} -> ${referenceMap[entry.ref]}: ${markdownText(entry.meta.title)}`,
    ),
    "",
    "## Historical entries (not activated)",
    "",
    ...entries
      .filter((entry) => !referenceMap[entry.ref])
      .map(
        (entry) =>
          `- ${entry.ref} (${entry.meta.status}): ${markdownText(entry.meta.title)}; original: originals/${entry.source}`,
      ),
    "",
    "## Warnings",
    "",
    ...(warnings.length
      ? warnings.map((w) => `- ${markdownText(w)}`)
      : ["None detected mechanically. Human review is still required."]),
    "",
    "See provenance.json for original metadata and content hashes; reference-map.json for machine-readable mappings.",
  ].join("\n");
  files.push({ path: "REVIEW.md", content: `${report}\n` });
  return {
    source,
    scope: options.scope,
    files,
    referenceMap,
    active: active.length,
    historical: entries.length - active.length,
    warnings,
  };
}

function canonicalDestination(output: string): string {
  let parent = resolve(output);
  const tail: string[] = [];
  while (!existsSync(parent)) {
    tail.unshift(basename(parent));
    parent = dirname(parent);
  }
  return join(realpathSync(parent), ...tail);
}

/** An explicit write creates a fresh staging directory, never a live notebook. */
export function writeMigration(plan: MigrationPlan, output: string): void {
  const destination = canonicalDestination(output);
  const rel = relative(plan.source, destination);
  if (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  ) {
    throw new Error("Staging output must be outside the source notebook.");
  }
  if (existsSync(destination)) {
    throw new Error(
      `Refusing to overwrite an existing destination: ${destination}`,
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  for (const file of plan.files) {
    const path = join(destination, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content, { flag: "wx" });
  }
  refreshIndex({
    kind: plan.scope,
    dir: join(destination, "notebook"),
    agentsFile: join(destination, "notebook", "AGENTS.md"),
  });
}
