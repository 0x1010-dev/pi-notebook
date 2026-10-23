import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { headCommit, staleness } from "./git.ts";

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

  execFileSync("git", ["commit", "-qam", "next"], { cwd: dir, stdio: "ignore" });
  assert.equal(staleness(dir, c), `Saved 1 commit ago (${c}).`);
  assert.match(staleness(dir, "deadbeef")!, /not in this history/);
});
