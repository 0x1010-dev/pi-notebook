import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type StorageMode = "repo" | "local";
export type ScopeKind = "global" | "project";

export interface Project {
  root: string;
  name: string;
}

export interface Scope {
  kind: ScopeKind;
  dir: string;
  /** AGENTS.md that holds the managed preferences or conventions section. */
  agentsFile: string;
  mode?: StorageMode;
  project?: Project;
}

export function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function notebookHome(): string {
  return join(agentDir(), "pi-notebook");
}

/** Nearest git root or folder with a notebook, never climbing above $HOME. */
export function findProject(
  cwd: string,
  home = homedir(),
): Project | undefined {
  let dir = cwd;
  while (true) {
    if (
      existsSync(join(dir, ".git")) ||
      existsSync(join(dir, ".pi", "notebook"))
    ) {
      return { root: dir, name: basename(dir) };
    }
    const parent = dirname(dir);
    if (parent === dir || dir === home) return undefined;
    dir = parent;
  }
}

export function globalScope(): Scope {
  return {
    kind: "global",
    dir: join(notebookHome(), "global"),
    agentsFile: join(agentDir(), "AGENTS.md"),
  };
}

export function projectScope(project: Project, mode: StorageMode): Scope {
  if (mode === "repo") {
    return {
      kind: "project",
      mode,
      project,
      dir: join(project.root, ".pi", "notebook"),
      agentsFile: join(project.root, "AGENTS.md"),
    };
  }
  const id = `${project.name}-${createHash("sha1").update(project.root).digest("hex").slice(0, 8)}`;
  const dir = join(notebookHome(), "projects", id);
  return {
    kind: "project",
    mode,
    project,
    dir,
    agentsFile: join(dir, "AGENTS.md"),
  };
}

export function existingProjectScope(project: Project): Scope | undefined {
  for (const mode of ["repo", "local"] as const) {
    const scope = projectScope(project, mode);
    if (existsSync(scope.dir)) return scope;
  }
  return undefined;
}
