import { execFileSync } from "node:child_process";

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return undefined;
  }
}

export function headCommit(cwd: string): string | undefined {
  return git(cwd, ["rev-parse", "--short", "HEAD"]) || undefined;
}

/** How far the code has moved since a note was saved, or undefined if unknown or unchanged. */
export function staleness(
  cwd: string,
  commit: string,
  files: string[] = [],
): string | undefined {
  if (git(cwd, ["cat-file", "-e", `${commit}^{commit}`]) === undefined)
    return `Saved at ${commit}, which is not in this history. Verify before relying on it.`;
  if (files.length) {
    // Compares with the working tree, so uncommitted edits count too.
    const changed = git(cwd, ["diff", "--name-only", commit, "--", ...files])
      ?.split("\n")
      .filter(Boolean);
    if (!changed?.length) return undefined;
    const shown = changed.slice(0, 3).join(", ");
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : "";
    return `May be outdated: ${shown}${more} changed since ${commit}.`;
  }
  const n = Number(git(cwd, ["rev-list", "--count", `${commit}..HEAD`]));
  return n > 0
    ? `Saved ${n} commit${n === 1 ? "" : "s"} ago (${commit}).`
    : undefined;
}
