import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { MANAGED_END, MANAGED_START } from "./store.ts";

export const FILES_REASON =
  "Use memory_save, memory_delete or handoff_update for model writes to the notebook. Reading and browsing notebook files is allowed; humans can edit memory files freely.";

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

function expand(path: string, home: string): string {
  if (path === "~") {
    return home;
  }
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function managedBlock(file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const content = readFileSync(file, "utf8");
  const start = content.indexOf(MANAGED_START);
  const end = content.indexOf(MANAGED_END);
  if (start < 0 || end <= start) {
    return undefined;
  }
  return content.slice(start, end + MANAGED_END.length);
}

export function managedWriteChanged(snapshot: ManagedWriteSnapshot): boolean {
  return managedBlock(snapshot.file) !== snapshot.block;
}

/** Keep model file writes on the tool path without restricting ordinary reading. */
export function guardToolCall(call: GuardInput): GuardVerdict | undefined {
  const home = call.home ?? homedir();
  const block = { action: "block", reason: FILES_REASON } as const;

  if (FILE_TOOLS.has(call.toolName) && typeof call.input.path === "string") {
    const target = resolve(call.cwd, expand(call.input.path, home));
    if (
      NOTEBOOK_SEGMENT.test(target) ||
      call.roots.some((root) => inside(target, root))
    ) {
      return block;
    }

    const agents = call.agentsFiles.find((file) => resolve(file) === target);
    if (agents) {
      return {
        action: "verify",
        snapshot: { file: target, block: managedBlock(target) },
      };
    }
  }

  return undefined;
}
