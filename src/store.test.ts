import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { after, test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "./paths.ts";
import {
  appendManaged, getEntry, initScope, keywords, listAll, normalizeTags,
  parseRef, preview, readHandoff, readManaged, recall, ref, refreshIndex, loadMemories,
  replaceManaged, deleteEntry, revision, saveEntry, searchEntries, updateEntry, writeHandoff,
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

test("deletion removes files and refs permanently without reusing IDs", () => {
  const s = scope();
  const e = saveEntry(s, "Database", "SQLite needs no server.");
  deleteEntry(s, e.id);
  assert.equal(getEntry(s, e.id), undefined);
  assert.equal(existsSync(e.path), false);
  assert.equal(existsSync(join(s.dir, "archive")), false);
  assert.deepEqual(searchEntries([s], "database"), []);
  assert.deepEqual(recall([s], "database", 3), []);
  assert.doesNotMatch(readFileSync(join(s.dir, "README.md"), "utf8"), /M1:/);
  assert.equal(saveEntry(s, "New", "New content.").id, 2);
  assert.throws(() => updateEntry(s, e.id, { title: "No" }), /not found/);
  assert.throws(() => updateEntry(s, 99, {}), /not found/);
});

test("failed atomic memory replacement preserves content and cleans temporary files", (t) => {
  const s = scope();
  const entry = saveEntry(s, "Original", "Keep this content.");
  const original = readFileSync(entry.path, "utf8");
  t.mock.method(fs, "renameSync", () => { throw new Error("Replacement failed"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => updateEntry(s, entry.id, { body: "Replacement" }), /Replacement failed/);
    assert.equal(readFileSync(entry.path, "utf8"), original);
    assert.equal(readdirSync(join(s.dir, "memories")).filter((name) => name.endsWith(".tmp")).length, 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("memory writes reuse and update a loaded collection without rescanning", (t) => {
  const s = scope();
  saveEntry(s, "Original", "Original knowledge.");
  const collection = loadMemories(s);
  const entries = collection.entries;
  t.mock.method(fs, "readdirSync", () => { throw new Error("Unexpected rescan"); });
  syncBuiltinESMExports();
  try {
    const added = saveEntry(s, "Added", "New knowledge.", {}, undefined, collection);
    assert.equal(added.id, 2);
    assert.equal(collection.maxId, 2);
    updateEntry(s, 1, { body: "Updated knowledge." }, undefined, collection);
    assert.equal(collection.entries, entries);
    assert.equal(getEntry(s, 1, collection)?.body, "Updated knowledge.");
    assert.equal(searchEntries([s], "added", 3, { entries }).length, 1);
    assert.match(readFileSync(join(s.dir, "README.md"), "utf8"), /Updated knowledge/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("deletion of converted memories reserves IDs and ignores old archive collections", () => {
  const s = scope();
  initScope(s);
  writeFileSync(join(s.dir, "memories/0042-converted.md"), "# Converted\n\nCurrent knowledge.\n");
  mkdirSync(join(s.dir, "archive"));
  writeFileSync(join(s.dir, "archive/0099-old.md"), "# Old\n\nHistorical knowledge.\n");
  assert.deepEqual(listAll(s).map((e) => e.id), [42]);
  deleteEntry(s, 42);
  assert.equal(saveEntry(s, "New", "New knowledge.").id, 43);
  deleteEntry(s, 43);
  assert.equal(saveEntry(s, "Next", "Next knowledge.").id, 44);
  assert.throws(() => deleteEntry(s, 42), /not found/);
});

test("invalid or duplicate memory files are diagnosed without hiding valid memories", () => {
  const s = scope();
  const e = saveEntry(s, "Valid", "Content");
  const original = readFileSync(e.path, "utf8");
  writeFileSync(e.path, "No heading");
  assert.equal(loadMemories(s).diagnostics.length, 1);
  assert.match(loadMemories(s).diagnostics[0].reason, /Invalid memory/);
  assert.throws(() => getEntry(s, 1), /need repair/);
  writeFileSync(e.path, original.replace(/updated:.*\n/, 'tags: ["broken", 1]\n'));
  assert.match(loadMemories(s).diagnostics[0].reason, /Invalid tags/);
  writeFileSync(e.path, original);
  writeFileSync(join(s.dir, "memories", "0001-duplicate.md"), original);
  assert.equal(loadMemories(s).diagnostics.length, 2);
  assert.ok(loadMemories(s).diagnostics.every((d) => d.reason.includes("Duplicate memory ID")));
  assert.deepEqual(listAll(s), []);
  const valid = saveEntry(s, "Another", "Still searchable.");
  assert.equal(valid.id, 2);
  assert.deepEqual(listAll(s).map(ref), ["M2"]);
  assert.equal(recall([s], "another", 3)[0].id, 2);
  assert.match(readFileSync(join(s.dir, "README.md"), "utf8"), /Files needing repair/);
});

test("YAML flow and block lists survive human edits and invalid metadata is contained", () => {
  const s = scope();
  initScope(s);
  const path = join(s.dir, "memories/0042-human.md");
  writeFileSync(path, "---\ntags: [braille, ratatui]\nfiles:\n  - src/tui.rs\n  - 'src/other.rs'\nupdated: 2026-11-02\n---\n# Human edit\n\nUse the canonical table.\n");
  assert.deepEqual(getEntry(s, 42)?.tags, ["braille", "ratatui"]);
  assert.deepEqual(getEntry(s, 42)?.files, ["src/tui.rs", "src/other.rs"]);
  assert.equal(getEntry(s, 42)?.date, "2026-11-02");
  for (const content of [
    "---\ntags: [broken\n---\n# Invalid\n\nContent",
    "---\ntags: [first]\ntags: [second]\n---\n# Invalid\n\nContent",
    "---\ntags:\n  - good\n  - {bad: mapping}\n---\n# Invalid\n\nContent",
    "---\ntags: [valid]\n# Unclosed",
  ]) {
    writeFileSync(path, content);
    assert.equal(loadMemories(s).diagnostics.length, 1);
    assert.deepEqual(listAll(s), []);
  }
  assert.equal(saveEntry(s, "Next", "Valid knowledge.").id, 43, "invalid files still reserve IDs");
  writeFileSync(path, "# Repaired\n\nUseful again.\n");
  assert.equal(loadMemories(s).diagnostics.length, 0);
  assert.equal(listAll(s).length, 2);
  refreshIndex(s);
  assert.doesNotMatch(readFileSync(join(s.dir, "README.md"), "utf8"), /Files needing repair/);
});

test("noncanonical filenames are reported and numeric prefixes reserve IDs", () => {
  const s = scope();
  initScope(s);
  writeFileSync(join(s.dir, "memories/0042.md"), "# Human\n\nKnowledge.");
  writeFileSync(join(s.dir, "memories/misc.md"), "# Other\n\nKnowledge.");
  assert.equal(loadMemories(s).diagnostics.length, 2);
  assert.equal(saveEntry(s, "Next", "Knowledge.").id, 43);
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

test("deleted and already-delivered candidates cannot crowd out eligible memories", () => {
  const s = scope();
  const target = saveEntry(s, "SQLite choice", "Use the local database.");
  for (let i = 0; i < 10; i++) {
    const e = saveEntry(s, "SQLite migrations locking rollback backup", "SQLite migrations locking rollback backup");
    deleteEntry(s, e.id);
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
  const original = readFileSync(join(s.dir, "handoff.md"), "utf8");
  assert.equal(existsSync(join(s.dir, "handoff.previous.md")), false);
  assert.deepEqual(readHandoff(s), h);
  assert.match(readFileSync(join(s.dir, "handoff.md"), "utf8"), /# Current handoff/);
  assert.match(readFileSync(join(s.dir, "README.md"), "utf8"), /\[Current handoff\]\(handoff.md\)/);
  writeHandoff(s, { ...h, status: "Complete", nextSteps: [] });
  assert.equal(readFileSync(join(s.dir, "handoff.previous.md"), "utf8"), original);
  const second = readFileSync(join(s.dir, "handoff.md"), "utf8");
  writeHandoff(s, { ...h, status: "Third snapshot", nextSteps: [] });
  assert.equal(readFileSync(join(s.dir, "handoff.previous.md"), "utf8"), second);
  assert.equal(readdirSync(s.dir).filter((name) => name.endsWith(".tmp")).length, 0);
  assert.deepEqual(readHandoff(s)?.nextSteps, []);
  assert.equal(readFileSync(join(s.dir, ".gitignore"), "utf8"), "handoff.md\nhandoff.previous.md\nhandoff.*.tmp\n");
});

test("handoff updates extend existing ignore rules without altering them", () => {
  const s = scope();
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(join(s.dir, ".gitignore"), "custom.txt\nhandoff.md");
  const h = { goal: "Ship", status: "Ready", nextSteps: [], blockers: [], notes: "", updated: "now" };
  writeHandoff(s, h);
  const ignores = readFileSync(join(s.dir, ".gitignore"), "utf8");
  assert.equal(ignores, "custom.txt\nhandoff.md\nhandoff.previous.md\nhandoff.*.tmp\n");
  writeHandoff(s, h);
  assert.equal(readFileSync(join(s.dir, ".gitignore"), "utf8"), ignores);
});

test("failed recovery-copy writes leave the current handoff intact and clean up temporary files", () => {
  const s = scope();
  const h = { goal: "Ship", status: "Ready", nextSteps: [], blockers: [], notes: "", updated: "now" };
  writeHandoff(s, h);
  const current = readFileSync(join(s.dir, "handoff.md"), "utf8");
  mkdirSync(join(s.dir, "handoff.previous.md"));
  assert.throws(() => writeHandoff(s, { ...h, status: "Wrong update" }));
  assert.equal(readFileSync(join(s.dir, "handoff.md"), "utf8"), current);
  assert.equal(readdirSync(s.dir).filter((name) => name.endsWith(".tmp")).length, 0);
});
