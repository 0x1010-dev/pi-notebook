export function wrapPrompt(inProject: boolean): string {
  const steps = [
    'For each decision made between real alternatives that is not already in the notebook index, call memory_save with kind "decision". Body: Context, Decision, Consequences.',
    'For each non-obvious problem solved that could recur, call memory_save with kind "lesson". Body: Symptom, Cause, Fix.',
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

export function curatePrompt(skillDirs: string[]): string {
  return [
    "Curate the pi-notebook using only the notebook tools.",
    '1. Call memory_search with query "*" to list every entry, then read related entries in full by passing their refs (for example "D1 D4").',
    "2. Merge duplicates: call memory_save with one clear combined entry and set supersedes to the refs it replaces.",
    "3. For entries that are no longer true, save a corrected entry that supersedes them.",
    `4. If three or more lessons describe the same procedure, propose a skill (in ${skillDirs.join(" or ")}) and ask me before writing it.`,
    "5. Do not try to edit or delete notebook files; those calls are blocked.",
    "Reply with a short summary of the changes.",
  ].join("\n");
}
