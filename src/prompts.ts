export function wrapPrompt(inProject: boolean): string {
  const steps = [
    'For each decision made between real alternatives, call memory_save with kind "decision" (context, choice, consequences in the body).',
    'For each non-obvious problem solved that could recur, call memory_save with kind "lesson" (symptom, cause, fix). Use kind "environment" only when the cause is my machine or accounts, not this project.',
    'If you learned how parts of this project\'s code work that are not recorded yet and would save a future session several file reads, call memory_save with kind "note" and files set to the paths it describes.',
    'If I stated lasting preferences or repo rules that are not recorded yet, call memory_save with kind "preference" or "convention".',
  ];
  if (inProject)
    steps.push(
      "Call handoff_update with the current goal, status, next steps and blockers.",
    );
  return [
    "Wrap up this session for pi-notebook.",
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    "If an entry in the index already covers something, update it by passing its ref to memory_save instead of adding a new one.",
    "Skip anything trivial or already recorded. Then reply with a short list of what you saved.",
  ].join("\n");
}

export function learnPrompt(topic: string): string {
  return [
    "Study this repository and record what a future session should know, using pi-notebook.",
    topic
      ? `Focus only on: ${topic}`
      : "Survey the whole repository: architecture, module layout, recurring code patterns and styling.",
    '1. Call memory_search with query "*" to see what the notebook already holds. Do not repeat it; read existing notes by ref and update those that turn out to be wrong (memory_save with their ref).',
    "2. Explore with bounded effort: README, manifest and config files, entry points, and a few representative files per area. Do not read every file.",
    "3. Skip anything AGENTS.md, ARCHITECTURE.md or similar docs already cover.",
    '4. For each thing a future session would otherwise need several file reads to work out, call memory_save with kind "note": title "area: summary", body with the details and key paths, files set to the paths it describes. Aim for a handful of notes, at most about 10.',
    '5. For rules the code consistently follows (naming, exports, error handling, formatting) that are not recorded yet, call memory_save with kind "convention", one rule per call. I will confirm each.',
    "Then reply with a short list of what you saved.",
  ].join("\n");
}

export function curatePrompt(skillDirs: string[]): string {
  return [
    "Curate the pi-notebook using only the notebook tools.",
    '1. Call memory_search with query "*" to list every entry, then read related entries in full by passing their refs (for example "D1 D4").',
    "2. Merge duplicates: update the clearest entry with memory_save and its ref so it covers both, then retire the others with memory_retire.",
    "3. For entries that are no longer true, update them with memory_save and their ref. If nothing should replace them, retire them with memory_retire.",
    "4. Read notes in full by ref. Those marked as possibly outdated: check the code, then update them by ref, retire them, or leave them if still accurate.",
    `5. If three or more lessons describe the same procedure, propose a skill (in ${skillDirs.join(" or ")}) and ask me before writing it.`,
    "6. Do not try to edit or delete notebook files; those calls are blocked.",
    "Reply with a short summary of the changes.",
  ].join("\n");
}
