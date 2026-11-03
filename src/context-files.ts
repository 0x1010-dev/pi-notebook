import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import type { NotebookConfig } from "./config.ts";
import { buildSection } from "./inject.ts";
import type { Located } from "./runtime.ts";
import type { ContextFile, Snapshot } from "./session.ts";
import { loadMemories, readHandoff, readManaged, revision } from "./store.ts";

export function loadNotebook({ scope, global }: Located) {
  const local = scope ? loadMemories(scope) : undefined;
  const everywhere = loadMemories(global);
  return {
    local, everywhere,
    projectEntries: local?.entries ?? [],
    globalEntries: everywhere.entries,
    diagnostics: [...(local?.diagnostics ?? []), ...everywhere.diagnostics],
    handoff: scope ? readHandoff(scope) : undefined,
    conventions: scope ? readManaged(scope.agentsFile) : [],
  };
}

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
export function syncContextFile(
  files: { path: string; content: string }[],
  file: ContextFile,
): void {
  const hit = files.find((f) => sameFile(f.path, file.path));
  if (hit) hit.content = file.content;
  else if (file.where === "start")
    files.unshift({ path: file.path, content: file.content });
  else files.push({ path: file.path, content: file.content });
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Detect human edits while retaining an unchanged system-prompt prefix between writes. */
export function notebookFingerprint(located: Located, loaded = loadNotebook(located)): string {
  const { project, scope, global } = located;
  const memories = [...loaded.projectEntries, ...loaded.globalEntries]
    .map((e) => [e.path, e.date, revision(e)]);
  return createHash("sha1").update(JSON.stringify([
    project?.root, memories, loaded.handoff, loaded.diagnostics,
    readIfExists(global.agentsFile), scope && readIfExists(scope.agentsFile),
  ])).digest("hex");
}

export function buildSnapshot(
  located: Located,
  cfg: NotebookConfig,
  loaded = loadNotebook(located),
): Snapshot {
  const { project, scope, global } = located;
  const files: ContextFile[] = [];
  const globalContent = readIfExists(global.agentsFile);
  if (globalContent !== undefined)
    files.push({
      path: global.agentsFile,
      content: globalContent,
      where: "start",
    });
  const repoContent =
    scope?.mode === "repo" ? readIfExists(scope.agentsFile) : undefined;
  if (scope && repoContent !== undefined)
    files.push({ path: scope.agentsFile, content: repoContent, where: "end" });
  return {
    section: buildSection({
      project,
      scope,
      global,
      budgetTokens: cfg.injectBudgetTokens,
      globalLimit: cfg.globalIndexLimit,
      snapshot: loaded,
    }),
    files,
  };
}
