import type { Project, Scope } from "./paths.ts";
import {
  type Entry,
  type Handoff,
  listAll,
  readHandoff,
  readManaged,
  ref,
} from "./store.ts";
import { ago } from "./ui.ts";

export interface InjectInput {
  project?: Project;
  scope?: Scope;
  global: Scope;
  budgetTokens: number;
  globalLimit: number;
}

const HEADER = [
  "Durable memory across sessions. Indexes below list titles only; read full entries with memory_search.",
  "Call handoff_update after agreeing on a plan, after finishing a piece of work, and whenever the work state changes.",
  "Record choices, non-obvious fixes and how the code works with memory_save. If an indexed entry already covers the topic, pass its ref to update it.",
  "Never read, list, edit or delete notebook files (.pi/notebook, ~/.pi/agent/pi-notebook) with file tools or shell commands. Those calls are blocked.",
  "Add preferences or conventions with memory_save, not by editing the pi-notebook section of AGENTS.md.",
];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** e.g. "2026-10-21 18:46 -04:00" in the machine's time zone. */
export function localTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${off < 0 ? "-" : "+"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const stamp = (h: Handoff) =>
  h.updated ? `${localTime(h.updated)}, ${ago(h.updated)} ago` : "unknown";

function handoffPointer(h: Handoff): string[] {
  const lines = [
    `<handoff updated="${stamp(h)}">`,
    "Where project work stands, saved by a previous session. Summary only.",
  ];
  if (h.goal) lines.push(`Goal: ${h.goal}`);
  if (h.nextSteps[0]) lines.push(`Next: ${h.nextSteps[0]}`);
  lines.push(
    'When resuming work or asked about the plan or status, read the full handoff (status, all next steps, blockers, notes) with memory_search "handoff", unless it is already in this conversation.',
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
        "Project notes (how the code works):",
        entries.filter((e) => e.kind === "note"),
        budget * 0.5,
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
      "Environment (user's machine, all projects):",
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
