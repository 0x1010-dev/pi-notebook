import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseQuery } from "./tools/memory-search.ts";
import { normalizeNoteFiles, noteFiles, projectPathIn } from "./tools/memory-save.ts";

test("note files are made repo-relative", () => {
  assert.deepEqual(
    normalizeNoteFiles(["/repo/src/a.ts", "./src/b.ts", "  ", "src/c.ts "], "/repo"),
    ["src/a.ts", "src/b.ts", "src/c.ts"],
  );
});

test("note files split into existing and dropped", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "");
  assert.deepEqual(noteFiles(["./src/a.ts", "src/missing.ts"], root), {
    files: ["src/a.ts"],
    dropped: ["src/missing.ts"],
  });
});

test("projectPathIn finds project paths", () => {
  const root = mkdtempSync(join(tmpdir(), "nb-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/a.ts"), "");
  assert.equal(projectPathIn("see src/a.ts", root), "src/a.ts");
  assert.equal(projectPathIn(`in ${root} only`, root), root);
  assert.equal(projectPathIn("brew services restart postgresql", root), undefined);
  assert.equal(projectPathIn("src/missing.ts", root), undefined);
});

test("query parsing", () => {
  assert.deepEqual(parseQuery(" * "), { mode: "all" });
  assert.deepEqual(parseQuery("handoff"), { mode: "handoff" });
  assert.deepEqual(parseQuery("Handoff"), { mode: "handoff" });
  assert.deepEqual(parseQuery("D3, ~L1"), { mode: "refs", refs: ["D3", "~L1"] });
  assert.deepEqual(parseQuery("auth cookies"), {
    mode: "keywords",
    words: ["auth", "cookies"],
  });
  assert.deepEqual(parseQuery("handoff D3"), {
    mode: "keywords",
    words: ["handoff", "D3"],
  });
  assert.deepEqual(parseQuery(""), { mode: "keywords", words: [] });
});
