const ADMISSION =
  "Keep only knowledge that changes a future action, prevents a likely mistake, or avoids costly rediscovery. Skip what existing docs already explain. Saving nothing is fine.";
const CURRENT =
  "Keep each memory a complete current account of one coherent topic, not a changelog. Update an existing memory by ref when appropriate. When correcting a claim, reconcile related memories that repeat it; preserve still-current knowledge before deleting a mixed-topic memory.";
const WRITING =
  "Put the useful conclusion first, followed by concise reasons and evidence. Distinguish observed facts and user decisions from hypotheses. Optional tags and related files help retrieval; reuse existing tags where useful.";

export function wrapPrompt(
  inProject: boolean,
  hasNotebook = inProject,
): string {
  const lines = [
    "Wrap up this session for pi-notebook.",
    ADMISSION,
    CURRENT,
    WRITING,
    "Use memory_save for worthwhile durable knowledge. Lasting rules require explicit user intent, not an inferred coding preference.",
  ];

  if (hasNotebook) {
    lines.push(
      "Update the handoff to a consistent snapshot of unfinished work. Reconcile goal, status, next actions and blockers; clear completed or obsolete items. Do not copy the session log into it.",
    );
  } else if (inProject) {
    lines.push(
      "There is no project notebook yet. Do not save temporary progress globally; tell the user that /nb:init is needed before a handoff can be saved.",
    );
  } else {
    lines.push(
      "Global memories must be durable and apply across projects. Never save this session's task, progress, plans, blockers, transcript or project-specific details globally; if nothing independently useful across projects remains, save nothing.",
    );
  }

  lines.push("Reply briefly with what changed, or say nothing needed saving.");
  return lines.join("\n");
}

export function curatePrompt(inProject = false): string {
  const lines = [
    "Curate the notebook into useful current knowledge, not a historical record.",
    'Browse memory_search "*", then read related memories by ref and verify their claims against current code, docs or other evidence.',
    CURRENT,
    ADMISSION,
    WRITING,
    "Resolve contradictions across active memories. Remove incorrect explanations rather than preserving them inside a corrected lesson. Do not claim verification you did not perform.",
    "Merge overlapping topics by updating the clearest memory into a complete current account before using memory_delete on redundant entries. Deletion is permanent and requires confirmation; no notebook history is kept. Split independently changing topics when needed.",
    "Keep rules short and limited to explicit user instructions. Flag questionable rules for the user rather than adding more.",
  ];
  if (inProject) {
    lines.push(
      "If the handoff is inconsistent, reconcile it against what is actually known; do not guess progress.",
    );
  } else {
    lines.push(
      "Global memories must be durable and apply across projects. Do not add current-session or project-specific progress to global memory; there is no global handoff.",
    );
  }
  lines.push(
    "Use notebook tools for changes. Reply with a short summary and any unresolved uncertainty.",
  );
  return lines.join("\n");
}
