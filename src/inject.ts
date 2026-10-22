import type { Project, Scope } from "./paths.ts";
import {
  type Entry,
  type Handoff,
  listAll,
  readHandoff,
  readManaged,
  ref,
} from "./store.ts";

export interface InjectInput {
  project?: Project;
  scope?: Scope;
  global: Scope;
  budgetTokens: number;
  globalLimit: number;
}

const HEADER = [
  "Durable memory that persists across sessions. The decision and lesson indexes below list titles only.",
  "Work with the notebook ONLY through its tools:",
  '- memory_search: find entries by keywords, read entries in full by ref ("D3 L1"), list all with "*", or read the project handoff with "handoff".',
  "- memory_save: record a preference, convention, decision or lesson. Save decisions and lessons to the project unless they are about the user's own setup across projects (machines, accounts, shell, installed tools). When unsure, use project.",
  "- handoff_update: record the current goal, status and next steps of project work. Call it after agreeing on a plan or starting multi-step work, and again when the state changes.",
  "Never read, list, edit or delete notebook files (.pi/notebook, ~/.pi/agent/pi-notebook) with file tools or shell commands. Those calls are blocked.",
  "To add preferences or conventions, use memory_save rather than editing the pi-notebook section of AGENTS.md.",
];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const stamp = (h: Handoff) => h.updated.slice(0, 16).replace("T", " ");

function handoffPointer(h: Handoff): string[] {
  const lines = [
    `<handoff updated="${stamp(h)}">`,
    "Where project work stands, saved by a previous session. Summary only.",
  ];
  if (h.goal) lines.push(`Goal: ${h.goal}`);
  if (h.nextSteps[0]) lines.push(`Next: ${h.nextSteps[0]}`);
  lines.push(
    'Read the full handoff (status, all next steps, blockers, notes) with memory_search "handoff" before answering about the plan, status or where things stand, and before continuing the work.',
    "</handoff>",
  );
  return lines;
}

export function formatHandoff(h: Handoff): string {
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  const parts = [`Handoff (updated ${stamp(h)})`];
  if (h.goal) parts.push(`Goal: ${h.goal}`);
  if (h.status) parts.push(`Status: ${h.status}`);
  if (h.nextSteps.length) parts.push(`Next steps:\n${list(h.nextSteps)}`);
  if (h.blockers.length) parts.push(`Blockers:\n${list(h.blockers)}`);
  if (h.todos.length) parts.push(`Open todos:\n${list(h.todos)}`);
  if (h.notes) parts.push(`Notes: ${h.notes}`);
  return parts.join("\n\n");
}

/** Newest active entries first, as many as fit the remaining budget. */
function indexBlock(
  title: string,
  entries: Entry[],
  budgetChars: number,
  limit = Infinity,
): string[] {
  const active = entries
    .filter((e) => e.status === "active")
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (active.length === 0) return [];
  const out = [title];
  let used = title.length;
  let shown = 0;
  for (const e of active) {
    const line = `  ${ref(e)} ${e.title}`;
    if (shown >= limit || used + line.length > budgetChars) break;
    out.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < active.length)
    out.push(`  (+${active.length - shown} more, use memory_search)`);
  return out;
}

export function buildSection(input: InjectInput): string {
  const { project, scope, global } = input;
  const h = project && scope ? readHandoff(scope) : undefined;
  const lines = [...(h ? [...handoffPointer(h), ""] : []), ...HEADER, ""];
  let budget = input.budgetTokens * 4 - lines.join("\n").length;
  const push = (block: string[]) => {
    if (block.length === 0) return;
    lines.push(...block);
    budget -= block.join("\n").length + 1;
  };

  if (project && scope) {
    push([
      `Project: ${project.name} (${project.root}), ${scope.mode} notebook`,
    ]);
    if (scope.mode === "local") {
      const conventions = readManaged(scope.agentsFile);
      if (conventions.length)
        push(["Project conventions:", ...conventions.map((c) => `  - ${c}`)]);
    }
    const entries = listAll(scope);
    push(
      indexBlock(
        "Project decisions:",
        entries.filter((e) => e.kind === "decision"),
        budget * 0.6,
      ),
    );
    push(
      indexBlock(
        "Project lessons:",
        entries.filter((e) => e.kind === "lesson"),
        budget * 0.6,
      ),
    );
  } else if (project) {
    push([
      `Project: ${project.name} (${project.root}), no notebook yet. memory_save will offer to create one.`,
    ]);
  }

  const globalEntries = listAll(global);
  push(
    indexBlock(
      "Global lessons:",
      globalEntries.filter((e) => e.kind === "lesson"),
      budget * 0.7,
      input.globalLimit,
    ),
  );
  push(
    indexBlock(
      "Global decisions:",
      globalEntries.filter((e) => e.kind === "decision"),
      budget,
      input.globalLimit,
    ),
  );

  return lines.join("\n").trim();
}
