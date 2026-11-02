import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planMigration, writeMigration } from "./migrate.ts";
import { listAll, readHandoff } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "nb-migrate-"));
after(() => rmSync(root, { recursive: true }));
let next = 0;
function fixture() {
  const source = join(root, `legacy-${++next}`);
  for (const dir of ["decisions", "lessons", "notes"]) mkdirSync(join(source, dir), { recursive: true });
  writeFileSync(join(source, "decisions/0001-choice.md"),
    "---\nid: 1\nkind: decision\ntitle: Database choice\nstatus: active\ndate: 2026-10-21\n---\n\nUse SQLite. See N2, L1 and ~L4.\n");
  writeFileSync(join(source, "lessons/0001-old.md"),
    "---\nid: 1\ntitle: Old fix\nstatus: superseded\nsuperseded_by: L2\n---\n\nHistorical advice.\n");
  writeFileSync(join(source, "notes/0002-tests.md"),
    "---\nid: 2\ntitle: Tests\nstatus: active\ndate: 2026-10-22\nfiles: src/a.ts, tests/a.ts\ncommit: abc123\n---\n\nSpawn the binary. Follow D1.\n");
  writeFileSync(join(source, "handoff.md"),
    "---\nupdated: 2026-10-23T12:00:00.000Z\n---\n\n## Goal\n\nShip D1\n\n## Status\n\nTests pending\n\n## Next steps\n\n- Check N2\n");
  return source;
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const [path, content] of Object.entries(snapshot(join(dir, entry.name))))
        out[`${entry.name}/${path}`] = content;
    } else out[entry.name] = readFileSync(join(dir, entry.name), "utf8");
  }
  return out;
}

test("dry-run preserves sources and plans only active entries, with historical and external warnings", () => {
  const source = fixture();
  const before = snapshot(source);
  const plan = planMigration({ source, scope: "project" });
  assert.equal(plan.active, 2);
  assert.equal(plan.historical, 1);
  assert.deepEqual(plan.referenceMap, { D1: "M1", N2: "M2" });
  assert.deepEqual(snapshot(source), before);
  assert.equal(plan.files.filter((f) => f.path.startsWith("notebook/memories/")).length, 2);
  assert.ok(plan.warnings.some((w) => w.includes("L1 (superseded)")));
  assert.ok(plan.warnings.some((w) => w.includes("~L4 (external or missing)")));
  assert.ok(plan.files.find((f) => f.path === "originals/lessons/0001-old.md"));
  const content = plan.files.find((f) => f.path.startsWith("notebook/memories/0001"))!.content;
  assert.match(content, /Use SQLite\. See M2, L1 and ~L4/);
  assert.match(content, /updated: 2026-10-21/);
});

test("explicit staging writes readable memories, reference map, provenance and converted handoff", () => {
  const source = fixture();
  const before = snapshot(source);
  const output = join(root, `stage-${next}`);
  const plan = planMigration({ source, scope: "project" });
  writeMigration(plan, output);
  const scope = { kind: "project" as const, dir: join(output, "notebook"), agentsFile: join(output, "AGENTS.md") };
  const entries = listAll(scope);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[1].files, ["src/a.ts", "tests/a.ts"]);
  assert.equal(entries[1].commit, "abc123");
  assert.equal(entries[1].date, "2026-10-22");
  assert.equal(readHandoff(scope)?.goal, "Ship M1");
  assert.deepEqual(readHandoff(scope)?.nextSteps, ["Check M2"]);
  assert.match(readFileSync(join(output, "notebook/README.md"), "utf8"), /M1: Database choice/);
  assert.match(readFileSync(join(output, "REVIEW.md"), "utf8"), /No claims were verified/);
  const provenance = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
  assert.equal(provenance.entries.length, 3);
  assert.match(provenance.entries[0].sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(snapshot(source), before);
  assert.throws(() => writeMigration(plan, output), /overwrite/);
});

test("output cannot be inside source, even through symlinked parent directories", () => {
  const source = fixture();
  const plan = planMigration({ source, scope: "project" });
  assert.throws(() => writeMigration(plan, source), /outside/);
  assert.throws(() => writeMigration(plan, join(source, "staging")), /outside/);
  const alias = join(root, `alias-${next}`);
  symlinkSync(source, alias);
  assert.throws(() => writeMigration(plan, join(alias, "nested/staging")), /outside/);
  assert.ok(!existsSync(join(source, "staging")));
});

test("global refs retain their scope, rules are preserved separately and not installed", () => {
  const source = fixture();
  writeFileSync(join(source, "decisions/0001-choice.md"),
    "---\nid: 1\ntitle: Tooling\nstatus: active\n---\n\nSee ~N2 and D1.\n");
  const rules = join(root, `rules-${next}.md`);
  writeFileSync(rules, "# Preferences\n\nKeep it brief; ~D1.\n");
  const plan = planMigration({ source, scope: "global", rules });
  assert.deepEqual(plan.referenceMap, { "~D1": "~M1", "~N2": "~M2" });
  assert.match(plan.files.find((f) => f.path.startsWith("notebook/memories/0001"))!.content, /See ~M2 and D1/);
  assert.equal(plan.files.find((f) => f.path === "originals/rules.md")?.content, readFileSync(rules, "utf8"));
  assert.ok(!plan.files.some((f) => f.path.endsWith("AGENTS.md")));
  assert.ok(plan.warnings.some((w) => w.includes("D1 (external or missing)")));
});

test("malformed files and symlinked sources fail before creating output", () => {
  const source = fixture();
  writeFileSync(join(source, "notes/0003-bad.md"), "No metadata");
  assert.throws(() => planMigration({ source, scope: "project" }), /frontmatter/);
  rmSync(join(source, "notes/0003-bad.md"));
  symlinkSync(join(source, "decisions/0001-choice.md"), join(source, "notes/0003-link.md"));
  assert.throws(() => planMigration({ source, scope: "project" }), /regular file/);
});

test("handoff-only notebooks can be staged without inventing memories", () => {
  const source = fixture();
  for (const dir of ["decisions", "lessons", "notes"])
    rmSync(join(source, dir), { recursive: true });
  const plan = planMigration({ source, scope: "project" });
  assert.equal(plan.active, 0);
  assert.equal(plan.historical, 0);
  assert.ok(plan.warnings.some((w) => w.includes("D1")));
  const output = join(root, `handoff-stage-${next}`);
  writeMigration(plan, output);
  assert.ok(existsSync(join(output, "notebook/handoff.md")));
  assert.match(readFileSync(join(output, "notebook/README.md"), "utf8"), /No memories yet/);
});

test("CLI defaults to read-only dry-run and requires explicit write arguments", () => {
  const source = fixture();
  const script = resolve("scripts/migrate.ts");
  const before = snapshot(source);
  const summary = execFileSync(process.execPath, ["--import", "tsx", script, "--source", source], { encoding: "utf8" });
  assert.equal(JSON.parse(summary).mode, "dry-run");
  assert.deepEqual(snapshot(source), before);
  const failed = spawnSync(process.execPath, ["--import", "tsx", script, "--source", source, "--write"], { encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /requires --output/);
  const output = join(root, `cli-stage-${next}`);
  execFileSync(process.execPath, ["--import", "tsx", script, "--source", source, "--output", output, "--write"]);
  assert.ok(existsSync(join(output, "REVIEW.md")));
  assert.deepEqual(snapshot(source), before);
});
