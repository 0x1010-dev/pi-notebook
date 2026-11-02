import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "./paths.ts";
import {
  appendManaged, getEntry, initScope, keywords, listAll, normalizeTags,
  parseRef, preview, readHandoff, readManaged, recall, ref, refreshIndex,
  replaceManaged, retireEntry, revision, saveEntry, searchEntries, updateEntry, writeHandoff,
} from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "nb-store-"));
after(() => rmSync(root, { recursive: true }));
let next = 0;
function scope(kind: Scope["kind"] = "project"): Scope {
  const dir = join(root, String(++next));
  return { kind, dir, agentsFile: join(dir, "AGENTS.md"), mode: "repo",
    project: kind === "project" ? { root, name: "test-project" } : undefined };
}

test("memory files are readable, editable, and indexed without redundant metadata", () => {
  const s = scope();
  initScope(s);
  const e = saveEntry(s, "Braille rendering", "Use the canonical dot table.\n\nIt avoids encoding mistakes.", {
    tags: ["#TUI", "tui", "rendering"], files: ["src/spark.ts"], commit: "a1b2c3d",
  });
  assert.equal(ref(e), "M1");
  assert.match(e.path, /memories\/0001-braille-rendering.md$/);
  const file = readFileSync(e.path, "utf8");
  assert.match(file, /# Braille rendering\n\nUse the canonical/);
  assert.doesNotMatch(file, /^(id|title|kind|status):/m);
  assert.deepEqual(getEntry(s, 1)?.tags, ["tui", "rendering"]);
  const index = readFileSync(join(s.dir, "README.md"), "utf8");
  assert.match(index, /\[M1: Braille rendering\]\(memories\/0001-braille-rendering.md\)/);
  assert.match(index, /Use the canonical dot table\./);
  assert.match(index, /#tui #rendering/);
  assert.match(index, /\[src\/spark.ts\]\(/);
  writeFileSync(e.path, file.replace("canonical dot table", "library lookup table"));
  refreshIndex(s);
  assert.match(readFileSync(join(s.dir, "README.md"), "utf8"), /library lookup table/);
  assert.equal(recall([s], "lookup table", 3)[0].id, e.id);
});

test("updates keep references and omitted fields, and allow clearing metadata", () => {
  const s = scope();
  const e = saveEntry(s, "Original", "Keep this.", { tags: ["foo"], files: ["a.ts"], commit: "abc" });
  const updated = updateEntry(s, e.id, { title: "Current", body: undefined, tags: undefined });
  assert.equal(updated.path, e.path);
  assert.equal(updated.body, "Keep this.");
  assert.equal(updated.commit, "abc");
  assert.deepEqual(updated.tags, ["foo"]);
  assert.deepEqual(updated.files, ["a.ts"]);
  assert.notEqual(revision(e), revision(updated));
  updateEntry(s, e.id, { tags: [], files: [] });
  assert.deepEqual(getEntry(s, e.id)?.tags, []);
  assert.deepEqual(getEntry(s, e.id)?.files, []);
});

test("archive removes ordinary search results, keeps explicit access and IDs", () => {
  const s = scope();
  const e = saveEntry(s, "Database", "SQLite needs no server.");
  retireEntry(s, e.id, "Replaced.");
  assert.match(getEntry(s, e.id)!.path, /archive\//);
  assert.equal(getEntry(s, e.id)?.status, "retired");
  assert.deepEqual(searchEntries([s], "database"), []);
  assert.equal(searchEntries([s], "database", 8, { includeRetired: true }).length, 1);
  assert.deepEqual(recall([s], "database", 3), []);
  assert.doesNotMatch(readFileSync(join(s.dir, "README.md"), "utf8"), /M1:/);
  assert.equal(saveEntry(s, "New", "New content.").id, 2);
  assert.throws(() => updateEntry(s, e.id, { title: "No" }), /retired/);
  assert.throws(() => updateEntry(s, 99, {}), /not found/);
});

test("invalid or duplicate memory files fail explicitly", () => {
  const s = scope();
  const e = saveEntry(s, "Valid", "Content");
  const original = readFileSync(e.path, "utf8");
  writeFileSync(e.path, "No heading");
  assert.throws(() => listAll(s), /Invalid memory/);
  writeFileSync(e.path, original.replace(/updated:.*\n/, 'tags: ["broken", 1]\n'));
  assert.throws(() => listAll(s), /Invalid tags/);
  writeFileSync(e.path, original);
  writeFileSync(join(s.dir, "memories", "0001-duplicate.md"), original);
  assert.throws(() => listAll(s), /Duplicate memory ID/);
});

test("refs, tags, tokens and previews have predictable semantics", () => {
  assert.deepEqual(parseRef("~m12"), { global: true, id: 12 });
  assert.equal(ref({ scope: "global", id: 12 }), "~M12");
  for (const invalid of ["D1", "M0", "M-1", "M9007199254740992"]) assert.equal(parseRef(invalid), undefined);
  assert.deepEqual(normalizeTags(["#SQLITE", "sqlite", "error handling"]), ["sqlite", "error-handling"]);
  const s = scope();
  saveEntry(s, "C++ details", "Use the documented compiler flags.", { tags: ["C++"] });
  assert.equal(searchEntries([s], "#c++").length, 1);
  assert.ok(keywords("caches class").includes("cache"));
  assert.ok(keywords("src/tui/spark.rs").includes("spark"));
  assert.deepEqual(keywords("the and of"), []);
  assert.equal(preview({ body: "Use the library.\n\nLong history omitted." }), "Use the library.");
  assert.ok(preview({ body: "word ".repeat(100) }, 100).length <= 100);
});

test("single topics and strong body-only matches recall without substring accidents", () => {
  const s = scope();
  const a = saveEntry(s, "SQLite persistence", "Avoid a separate database server.");
  const b = saveEntry(s, "Shutdown", "Close worker connections when the test runner hangs.");
  saveEntry(s, "OAuth callbacks", "Register the provider redirect.");
  assert.deepEqual(recall([s], "sqlite", 3).map(ref), [ref(a)]);
  assert.ok(recall([s], "test runner hangs", 3).some((e) => e.id === b.id));
  assert.deepEqual(searchEntries([s], "auth"), []);
  assert.deepEqual(recall([s], "the and of", 3), []);
  assert.deepEqual(recall([s], "sqlite", 0), []);
});

test("tags and project paths retrieve memories with explicit AND tag constraints", () => {
  const s = scope();
  const a = saveEntry(s, "Rendering", "Use the library table.", {
    tags: ["braille", "tui"], files: ["src/tui/spark.rs"],
  });
  saveEntry(s, "Other", "Use semantic colors.", { tags: ["tui"] });
  saveEntry(s, "Panel layout", "Keep values visible.", { files: ["src/tui/render.rs"] });
  assert.deepEqual(searchEntries([s], "#braille #tui").map((h) => ref(h.entry)), [ref(a)]);
  assert.deepEqual(searchEntries([s], "#braille #missing"), []);
  assert.equal(recall([s], "braille", 3)[0].id, a.id);
  assert.equal(recall([s], "src/tui/spark.rs", 3)[0].id, a.id);
  assert.deepEqual(recall([s], "src/tui/spark.rs", 3).map(ref), [ref(a)]);
  assert.equal(recall([s], "src/tui", 3).length, 2);
});

test("inactive and already-delivered candidates cannot crowd out eligible memories", () => {
  const s = scope();
  const target = saveEntry(s, "SQLite choice", "Use the local database.");
  for (let i = 0; i < 10; i++) {
    const e = saveEntry(s, "SQLite migrations locking rollback backup", "SQLite migrations locking rollback backup");
    retireEntry(s, e.id, "Old.");
  }
  const newer = saveEntry(s, "SQLite migrations", "SQLite migration guidance.");
  const hits = recall([s], "SQLite", 1, (e) => e.id === newer.id);
  assert.deepEqual(hits.map(ref), [ref(target)]);
});

test("rarity and direct fields prioritize specific knowledge over generic mentions", () => {
  const s = scope();
  const wanted = saveEntry(s, "Display width", "Measure terminal cells, not Unicode character counts.", { tags: ["ratatui"] });
  for (let i = 0; i < 6; i++) saveEntry(s, `General ${i}`, "Display current power and status.");
  assert.equal(searchEntries([s], "ratatui terminal cells")[0].entry.id, wanted.id);
});

test("rules preserve human content and replace the managed block", () => {
  const s = scope();
  initScope(s);
  writeFileSync(s.agentsFile, "# Human instructions\n\nLeave this alone.\n");
  assert.equal(appendManaged(s.agentsFile, "## Preferences", "Use pnpm"), true);
  assert.equal(appendManaged(s.agentsFile, "## Preferences", "Use pnpm"), false);
  replaceManaged(s.agentsFile, "## Preferences", ["Use bun", "Be brief"]);
  assert.deepEqual(readManaged(s.agentsFile), ["Use bun", "Be brief"]);
  assert.match(readFileSync(s.agentsFile, "utf8"), /Leave this alone/);
});

test("handoff is a readable snapshot with an index pointer", () => {
  const s = scope();
  initScope(s);
  const h = {
    goal: "Ship", status: "Implementation done", nextSteps: ["Test", "Document"],
    blockers: [], notes: "", updated: "2026-10-23T12:00:00.000Z",
  };
  writeHandoff(s, h);
  assert.deepEqual(readHandoff(s), h);
  assert.match(readFileSync(join(s.dir, "handoff.md"), "utf8"), /# Current handoff/);
  assert.match(readFileSync(join(s.dir, "README.md"), "utf8"), /\[Current handoff\]\(handoff.md\)/);
  writeHandoff(s, { ...h, status: "Complete", nextSteps: [] });
  assert.deepEqual(readHandoff(s)?.nextSteps, []);
  assert.equal(readFileSync(join(s.dir, ".gitignore"), "utf8"), "handoff.md\n");
});
