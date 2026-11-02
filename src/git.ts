import { execFile, execFileSync } from "node:child_process";

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
  const checks = stalenessChecks(commit, files);
  let step = checks.next();
  while (!step.done) step = checks.next(git(cwd, step.value));
  return step.value;
}

/** Per-view cache: identical checks share a subprocess, without blocking the TUI. */
export function createStalenessChecker(cwd: string, signal?: AbortSignal) {
  const results = new Map<string, Promise<string | undefined>>();
  const run = (args: string[]): Promise<string | undefined> => {
    const key = JSON.stringify(args);
    let result = results.get(key);
    if (!result) {
      result = new Promise((resolve) => {
        execFile("git", args, { cwd, encoding: "utf8", timeout: 2000, signal },
          (error, stdout) => resolve(error ? undefined : stdout.trim()));
      });
      results.set(key, result);
    }
    return result;
  };
  return async (commit: string, files: string[] = []): Promise<string | undefined> => {
    const checks = stalenessChecks(commit, files);
    let step = checks.next();
    while (!step.done) {
      if (signal?.aborted) return undefined;
      step = checks.next(await run(step.value));
    }
    return step.value;
  };
}

function* stalenessChecks(
  commit: string,
  files: string[],
): Generator<string[], string | undefined, string | undefined> {
  if ((yield ["cat-file", "-e", `${commit}^{commit}`]) === undefined)
    return `Saved at ${commit}, which is not in this history. Verify before relying on it.`;
  if (files.length) {
    // Compares with the working tree, so uncommitted edits count too.
    const diff = yield ["diff", "--name-only", commit, "--", ...files];
    const untracked = yield ["ls-files", "--others", "--exclude-standard", "--", ...files];
    if (diff === undefined || untracked === undefined)
      return "Could not verify related files against the saved commit. Check the code before relying on this memory.";
    const changed = [...new Set(`${diff}\n${untracked}`.split("\n").filter(Boolean))];
    if (!changed.length) return undefined;
    const shown = changed.slice(0, 3).join(", ");
    const more = changed.length > 3 ? ` and ${changed.length - 3} more` : "";
    return `May be outdated: ${shown}${more} changed since ${commit}.`;
  }
  const distance = yield ["rev-list", "--count", `${commit}..HEAD`];
  if (distance === undefined)
    return "Could not compare the saved commit with HEAD. Verify before relying on this memory.";
  const n = Number(distance);
  return n > 0
    ? `Saved ${n} commit${n === 1 ? "" : "s"} ago (${commit}).`
    : undefined;
}
