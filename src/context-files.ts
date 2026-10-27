import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { NotebookConfig } from "./config.ts";
import { buildSection } from "./inject.ts";
import type { Located } from "./runtime.ts";
import type { ContextFile, Snapshot } from "./session.ts";

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

export function buildSnapshot(
  { project, scope, global }: Located,
  cfg: NotebookConfig,
): Snapshot {
  const files: ContextFile[] = [];
  const globalContent = readIfExists(global.agentsFile);
  if (globalContent !== undefined)
    files.push({ path: global.agentsFile, content: globalContent, where: "start" });
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
    }),
    files,
  };
}
