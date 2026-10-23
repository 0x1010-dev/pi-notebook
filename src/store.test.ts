import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Scope } from "./paths.ts";
import {
  appendManaged,
  findSimilar,
  initScope,
  listEntries,
  parseRef,
  readHandoff,
  readManaged,
  recall,
  ref,
  replaceManaged,
  retireEntry,
  saveEntry,
  searchEntries,
  supersedeEntry,
  writeHandoff,
} from "./store.ts";

function scope(kind: Scope["kind"] = "project"): Scope {
  const dir = mkdtempSync(join(tmpdir(), "nb-"));
  return { kind, dir, agentsFile: join(dir, "AGENTS.md"), mode: "repo" };
}

test("saveEntry numbers entries and supersedes", () => {
  const s = scope();
  initScope(s);
  const a = saveEntry(s, "decision", "Use SQLite: for cache", "Context: x");
  const c = saveEntry(s, "decision", "Use Redis", "Context: z");
  const b = saveEntry(s, "decision", "Use Postgres", "Context: y", [
    a.id,
    c.id,
  ]);
  assert.equal(a.id, 1);
  assert.equal(b.id, 3);
  const all = listEntries(s, "decision");
  assert.equal(all[0].status, "superseded");
  assert.equal(all[0].supersededBy, "D3");
  assert.equal(all[1].supersededBy, "D3");
  assert.equal(all[0].title, "Use SQLite: for cache");
  assert.deepEqual(all[2].supersedes, [1, 2]);
  assert.equal(all[2].status, "active");
  assert.equal(readFileSync(join(s.dir, ".gitignore"), "utf8"), "handoff.md\n");
});

test("supersedeEntry promotes across scopes and old numeric refs still parse", () => {
  const project = scope();
  const global = scope("global");
  const p = saveEntry(project, "lesson", "Tokio broadcast for fan-out", "x");
  const g = saveEntry(global, "lesson", "Tokio broadcast for fan-out", "x");
  supersedeEntry(project, "lesson", p.id, ref(g));
  assert.equal(listEntries(project, "lesson")[0].supersededBy, "~L1");
  assert.throws(
    () => supersedeEntry(project, "lesson", 9, "~L1"),
    /L9 not found/,
  );

  writeFileSync(
    p.path,
    "---\nid: 1\nkind: lesson\ntitle: t\nstatus: superseded\nsuperseded_by: 2\n---\n\nx\n",
  );
  assert.equal(listEntries(project, "lesson")[0].supersededBy, "L2");
});

test("saveEntry rejects unknown supersedes", () => {
  const s = scope();
  assert.throws(() => saveEntry(s, "lesson", "x", "y", [9]), /L9 not found/);
});

test("retireEntry keeps the file but drops it from recall and duplicates", () => {
  const s = scope();
  const e = saveEntry(s, "lesson", "Brew postgres needs restart", "x");
  retireEntry(s, "lesson", e.id, "moved to\ndocker");
  const [r] = listEntries(s, "lesson");
  assert.equal(r.status, "retired");
  assert.equal(r.retiredReason, "moved to docker");
  assert.equal(searchEntries([s], "postgres restart").length, 1);
  assert.deepEqual(recall([s], "brew postgres restart", 3), []);
  assert.equal(findSimilar(s, "lesson", "Brew postgres needs restart"), undefined);
});

test("refs round-trip", () => {
  assert.equal(ref({ scope: "global", kind: "lesson", id: 4 }), "~L4");
  assert.deepEqual(parseRef("~L4"), { global: true, kind: "lesson", id: 4 });
  assert.deepEqual(parseRef("d12"), {
    global: false,
    kind: "decision",
    id: 12,
  });
  assert.equal(parseRef("X1"), undefined);
  assert.deepEqual(parseRef("n2"), { global: false, kind: "note", id: 2 });
});

test("notes keep files and commit", () => {
  const s = scope();
  initScope(s);
  const n = saveEntry(s, "note", "auth: session cookies", "Middleware in src/auth", [], {
    files: ["src/auth", "src/server.ts"],
    commit: "a1b2c3d",
  });
  assert.equal(ref(n), "N1");
  const [r] = listEntries(s, "note");
  assert.deepEqual(r.files, ["src/auth", "src/server.ts"]);
  assert.equal(r.commit, "a1b2c3d");
});

test("search ranks title matches and demotes superseded", () => {
  const s = scope();
  saveEntry(
    s,
    "lesson",
    "Brew postgres needs restart",
    "Symptom: config ignored",
  );
  saveEntry(s, "lesson", "Unrelated", "mentions postgres once");
  const hits = searchEntries([s], "postgres restart");
  assert.equal(hits[0].entry.title, "Brew postgres needs restart");
  assert.equal(hits.length, 2);
});

test("managed section is created once and appended", () => {
  const s = scope();
  appendManaged(s.agentsFile, "## Preferences", "use pnpm");
  appendManaged(s.agentsFile, "## Preferences", "no em-dashes\nplease");
  const src = readFileSync(s.agentsFile, "utf8");
  assert.equal(src.match(/## Preferences/g)?.length, 1);
  assert.deepEqual(readManaged(s.agentsFile), [
    "use pnpm",
    "no em-dashes please",
  ]);
});

test("managed section preserves existing content", () => {
  const s = scope();
  const before = "# Mine\n\nhand written\n";
  writeFileSync(s.agentsFile, before);
  appendManaged(s.agentsFile, "## Preferences", "a");
  appendManaged(s.agentsFile, "## Preferences", "b");
  const out = readFileSync(s.agentsFile, "utf8");
  assert.ok(out.startsWith(before));
  assert.deepEqual(readManaged(s.agentsFile), ["a", "b"]);
});

test("handoff round-trips", () => {
  const s = scope();
  const h = {
    goal: "Ship v1",
    status: "Tests pass.\nDocs pending.",
    nextSteps: ["write docs", "tag release"],
    blockers: [],
    notes: "",
    updated: "2026-10-21T10:00:00.000Z",
  };
  writeHandoff(s, h);
  assert.deepEqual(readHandoff(s), h);
});

test("findSimilar matches near-duplicate titles only", () => {
  const s = scope();
  const a = saveEntry(
    s,
    "lesson",
    "Brew postgres needs restart after config change",
    "x",
  );
  assert.equal(
    findSimilar(
      s,
      "lesson",
      "Postgres from brew needs a restart after config change",
    )?.id,
    a.id,
  );
  assert.equal(
    findSimilar(s, "lesson", "Redis cache eviction policy"),
    undefined,
  );
  assert.equal(
    findSimilar(
      s,
      "decision",
      "Brew postgres needs restart after config change",
    ),
    undefined,
  );
});

test("recall needs a title match and ignores stopwords", () => {
  const s = scope();
  saveEntry(
    s,
    "lesson",
    "Vitest hangs on open handles",
    "Symptom: the test run never exits",
  );
  saveEntry(s, "lesson", "Unrelated", "the and of to with test");
  const hits = recall([s], "why does vitest hang when the test run ends?", 3);
  assert.deepEqual(
    hits.map((e) => e.title),
    ["Vitest hangs on open handles"],
  );
  assert.deepEqual(recall([s], "what is the weather", 3), []);
  assert.deepEqual(recall([s], "vitest hangs", 0), []);
});

test("replaceManaged rewrites only the managed lines", () => {
  const s = scope();
  writeFileSync(s.agentsFile, "# Mine\n");
  replaceManaged(s.agentsFile, "## Preferences", []);
  assert.equal(readFileSync(s.agentsFile, "utf8"), "# Mine\n");
  replaceManaged(s.agentsFile, "## Preferences", ["a", "b"]);
  replaceManaged(s.agentsFile, "## Preferences", ["c"]);
  const out = readFileSync(s.agentsFile, "utf8");
  assert.ok(out.startsWith("# Mine\n"));
  assert.equal(out.match(/## Preferences/g)?.length, 1);
  assert.deepEqual(readManaged(s.agentsFile), ["c"]);
});
