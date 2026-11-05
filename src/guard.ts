import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MANAGED_END, MANAGED_START } from "./store.ts";

export const FILES_REASON =
  'Use memory_save, memory_delete or handoff_update for model writes to the notebook. Reading and browsing notebook files is allowed; humans can edit memory files freely.';

export const MANAGED_WARNING =
  "Note: this change touched the pi-notebook section of AGENTS.md. Prefer memory_save with kind rule for user-approved additions there. If the change was intentional, carry on.";

export type GuardVerdict =
  | { action: "block"; reason: string }
  | { action: "verify"; snapshot: ManagedWriteSnapshot };

export interface ManagedWriteSnapshot {
  file: string;
  block: string | undefined;
}

const FILE_TOOLS = new Set(["edit", "write"]);
const NOTEBOOK_SEGMENT = /(^|\/)\.pi\/(notebook|agent\/pi-notebook)(\/|$)/;

export interface GuardInput {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  /** Absolute notebook roots, e.g. the global notebook home. */
  roots: string[];
  /** AGENTS.md files that may hold a managed section. */
  agentsFiles: string[];
  home?: string;
}

function expand(p: string, home: string): string {
  if (p === "~") return home;
  return p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function managedBlock(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const src = readFileSync(file, "utf8");
  const s = src.indexOf(MANAGED_START);
  const e = src.indexOf(MANAGED_END);
  return s >= 0 && e > s ? src.slice(s, e + MANAGED_END.length) : undefined;
}

export function managedWriteChanged(snapshot: ManagedWriteSnapshot): boolean {
  return managedBlock(snapshot.file) !== snapshot.block;
}

/** Keep model file writes on the tool path without restricting ordinary reading. */
export function guardToolCall(g: GuardInput): GuardVerdict | undefined {
  const home = g.home ?? homedir();
  const block = { action: "block", reason: FILES_REASON } as const;

  if (FILE_TOOLS.has(g.toolName) && typeof g.input.path === "string") {
    const target = resolve(g.cwd, expand(g.input.path, home));
    if (NOTEBOOK_SEGMENT.test(target) || g.roots.some((r) => inside(target, r)))
      return block;

    const agents = g.agentsFiles.find((f) => resolve(f) === target);
    if (agents)
      return { action: "verify", snapshot: { file: target, block: managedBlock(target) } };
  }

  return undefined;
}
