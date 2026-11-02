const ADMISSION =
  "Keep only knowledge that changes a future action, prevents a likely mistake, or avoids costly rediscovery. Skip what existing docs already explain. Saving nothing is fine.";
const CURRENT =
  "Keep each memory a complete current account of one coherent topic, not a changelog. Update an existing memory by ref when appropriate. When correcting a claim, reconcile related active memories that repeat it; do not retire an entire mixed-topic entry and lose still-current knowledge.";
const WRITING =
  "Put the useful conclusion first, followed by concise reasons and evidence. Distinguish observed facts and user decisions from hypotheses. Optional tags and related files help retrieval; reuse existing tags where useful.";

export function wrapPrompt(inProject: boolean): string {
  return [
    "Wrap up this session for pi-notebook.",
    ADMISSION, CURRENT, WRITING,
    "Use memory_save for worthwhile durable knowledge. Lasting rules require explicit user intent, not an inferred coding preference.",
    ...(inProject ? [
      "Update the handoff to a consistent snapshot of unfinished work. Reconcile goal, status, next actions and blockers; clear completed or obsolete items. Do not copy the session log into it.",
    ] : []),
    "Reply briefly with what changed, or say nothing needed saving.",
  ].join("\n");
}

export function learnPrompt(topic: string): string {
  return [
    "Look for valuable knowledge gaps in this repository, not a comprehensive notebook.",
    topic ? `Focus on: ${topic}` : "Focus on hidden constraints, important rationale and non-obvious cross-file dependencies.",
    'Browse existing memories with memory_search "*" and consult project documentation before exploring relevant code with bounded effort.',
    ADMISSION, CURRENT, WRITING,
    "Use memory_save only for worthwhile gaps. Do not invent rules from incidental patterns or aim for a quota of memories.",
    "Reply briefly with what was learned and saved, or why no new memories were needed.",
  ].join("\n");
}

export function curatePrompt(): string {
  return [
    "Curate the notebook into useful current knowledge, not a historical record.",
    'Browse memory_search "*", then read related memories by ref and verify their claims against current code, docs or other evidence.',
    CURRENT, ADMISSION, WRITING,
    "Resolve contradictions across active memories. Remove incorrect explanations rather than preserving them inside a corrected lesson. Do not claim verification you did not perform.",
    "Merge overlapping topics by updating the clearest memory into a complete current account before retiring redundant entries. Split independently changing topics when needed.",
    "Keep rules short and limited to explicit user instructions. Flag questionable rules for the user rather than adding more.",
    "If the handoff is inconsistent, reconcile it against what is actually known; do not guess progress.",
    "Use notebook tools for changes. Reply with a short summary and any unresolved uncertainty.",
  ].join("\n");
}
