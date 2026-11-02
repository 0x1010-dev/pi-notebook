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

/** How far the code has moved since a memory was saved, or undefined if unchanged. */
export function staleness(
  cwd: string,
  commit: string,
  files: string[] = [],
): string | undefined {
  if (git(cwd, ["cat-file", "-e", `${commit}^{commit}`]) === undefined)
    return `Saved at ${commit}, which is not in this history. Verify before relying on it.`;
  if (files.length) {
    // Compares with the working tree, so uncommitted edits count too.
    const diff = git(cwd, ["diff", "--name-only", commit, "--", ...files]);
    const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard", "--", ...files]);
    if (diff === undefined || untracked === undefined)
      return "Could not verify related files against the saved commit. Check the code before relying on this memory.";
    const changed = [...new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean))];
    if (!changed.length) return undefined;
    const shown = changed.slice(0, 3).join(", ");
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : "";
    return `May be outdated: ${shown}${more} changed since ${commit}.`;
  }
  const distance = git(cwd, ["rev-list", "--count", `${commit}..HEAD`]);
  if (distance === undefined)
    return "Could not compare the saved commit with HEAD. Verify before relying on this memory.";
  const n = Number(distance);
  return n > 0
    ? `Saved ${n} commit${n === 1 ? "" : "s"} ago (${commit}).`
    : undefined;
}
