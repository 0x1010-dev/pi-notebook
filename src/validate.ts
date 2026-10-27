import { oneLine } from "./store.ts";

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

export const TITLE_MAX = 120;
export const BODY_MAX = 8000;

/** Shorten to TITLE_MAX at a word boundary. */
export function clipTitle(title: string): { title: string; clipped: boolean } {
  const clean = oneLine(title);
  if (clean.length <= TITLE_MAX) return { title: clean, clipped: false };
  const space = clean.lastIndexOf(" ", TITLE_MAX - 1);
  const cut = space > 0 ? clean.slice(0, space) : clean.slice(0, TITLE_MAX - 1);
  return { title: `${cut.trimEnd()}…`, clipped: true };
}
