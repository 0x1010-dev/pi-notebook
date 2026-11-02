import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStalenessChecker, headCommit, staleness } from "./git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nb-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.ts"), "a");
  writeFileSync(join(dir, "b.ts"), "b");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

test("staleness tracks described files and commit distance", () => {
  const dir = repo();
  const c = headCommit(dir)!;
  assert.ok(c);
  assert.equal(staleness(dir, c, ["a.ts"]), undefined);
  assert.equal(staleness(dir, c), undefined);

  writeFileSync(join(dir, "a.ts"), "changed");
  assert.match(staleness(dir, c, ["a.ts"])!, /May be outdated: a\.ts changed/);
  assert.equal(staleness(dir, c, ["b.ts"]), undefined);
  writeFileSync(join(dir, "new.ts"), "new, untracked source");
  assert.match(staleness(dir, c, ["new.ts"])!, /May be outdated: new\.ts changed/);

  execFileSync("git", ["commit", "-qam", "next"], { cwd: dir, stdio: "ignore" });
  assert.equal(staleness(dir, c), `Saved 1 commit ago (${c}).`);
  assert.match(staleness(dir, "deadbeef")!, /not in this history/);
});

test("asynchronous freshness matches synchronous checks and caches only within one view", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true }));
  const commit = headCommit(dir)!;
  writeFileSync(join(dir, "a.ts"), "changed");
  writeFileSync(join(dir, "new.ts"), "untracked");
  const check = createStalenessChecker(dir);
  for (const [baseline, files] of [
    [commit, ["a.ts"]], [commit, ["b.ts"]], [commit, ["new.ts"]],
    [commit, []], ["deadbeef", []],
  ] as const) {
    assert.equal(await check(baseline, [...files]), staleness(dir, baseline, [...files]));
  }
  writeFileSync(join(dir, "b.ts"), "changed since opening");
  assert.equal(await check(commit, ["b.ts"]), undefined);
  assert.match((await createStalenessChecker(dir)(commit, ["b.ts"]))!, /b\.ts changed/);
});
