export function wrapPrompt(inProject: boolean): string {
  const steps = [
    'For each decision made between real alternatives that is not already in the notebook index, call memory_save with kind "decision". Body: Context, Decision, Consequences.',
    'For each non-obvious problem solved that could recur, call memory_save with kind "lesson". Body: Symptom, Cause, Fix.',
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
    "Skip anything trivial or already recorded. Then reply with a short list of what you saved.",
  ].join("\n");
}

export function learnPrompt(topic: string): string {
  return [
    "Study this repository and record what a future session should know, using pi-notebook.",
    topic
      ? `Focus only on: ${topic}`
      : "Survey the whole repository: architecture, module layout, recurring code patterns and styling.",
    '1. Call memory_search with query "*" to see what the notebook already holds. Do not repeat it; read existing notes by ref and supersede those that turn out to be wrong.',
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
    "2. Merge duplicates: call memory_save with one clear combined entry and set supersedes to the refs it replaces.",
    "3. For entries that are no longer true, save a corrected entry that supersedes them. If nothing replaces them, retire them with memory_retire.",
    "4. Read notes in full by ref. Those marked as possibly outdated: check the code, then supersede, retire, or leave them if still accurate.",
    `5. If three or more lessons describe the same procedure, propose a skill (in ${skillDirs.join(" or ")}) and ask me before writing it.`,
    "6. If a project decision or lesson turns out to apply beyond this project (it is about my own setup, or the same lesson already exists elsewhere), promote it: memory_save with scope global and supersedes set to its project ref. I will be asked to confirm. Notes stay in the project.",
    "7. Do not try to edit or delete notebook files; those calls are blocked.",
    "Reply with a short summary of the changes.",
  ].join("\n");
}
