import type { EntryKind } from "./store.ts";

const SECRET_PATTERNS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  [
    "GitHub token",
    /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  ],
  ["API key", /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["credentials in URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  [
    "secret assignment",
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\b\s*[:=]\s*["']?(?![<$*{])[^\s"']{6,}/i,
  ],
];

/** Name of the first secret-looking pattern found, if any. */
export function findSecret(text: string): string | undefined {
  return SECRET_PATTERNS.find(([, re]) => re.test(text))?.[0];
}

export function secretError(kind: string): string {
  return `Not saved: the text looks like it contains a ${kind}. Notebook entries may be committed to git and are shown to every future session. Replace the value with a placeholder such as <REDACTED> or $ENV_VAR and try again.`;
}

const SECTIONS: Record<EntryKind, string[]> = {
  decision: ["Context", "Decision", "Consequences"],
  lesson: ["Symptom", "Cause", "Fix"],
  note: [],
};

const has = (body: string, label: string) =>
  new RegExp(`(^|\\n)\\s*(#{1,6}\\s*)?\\**${label}\\**\\s*(:|\\n)`, "i").test(
    body,
  );

/** Error message when the body lacks the required sections. */
export function checkStructure(
  kind: EntryKind,
  body: string,
): string | undefined {
  const missing = SECTIONS[kind].filter((s) => !has(body, s));
  if (missing.length === 0) return undefined;
  const example = SECTIONS[kind].map((s) => `${s}: ...`).join("\n");
  return `Not saved: a ${kind} body needs these sections, missing ${missing.join(", ")}. Use this shape:\n${example}`;
}
