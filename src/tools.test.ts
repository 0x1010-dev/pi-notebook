import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeMemoryFiles } from "./tools/memory-save.ts";
import { parseQuery } from "./tools/memory-search.ts";

test("related paths normalize, deduplicate and need not exist", () => {
  assert.deepEqual(normalizeMemoryFiles(
    ["/repo/src/a.ts", "./src/b.ts", " ", "src/a.ts", "src/missing.ts"], "/repo",
  ), ["src/a.ts", "src/b.ts", "src/missing.ts"]);
  assert.throws(() => normalizeMemoryFiles(["../outside"], "/repo"), /outside this project/);
  assert.throws(() => normalizeMemoryFiles(["/private/file"], "/repo"), /outside this project/);
});

test("query parsing", () => {
  assert.deepEqual(parseQuery(" * "), { mode: "all" });
  assert.deepEqual(parseQuery("Handoff"), { mode: "handoff" });
  assert.deepEqual(parseQuery("M3, ~M1"), { mode: "refs", refs: ["M3", "~M1"] });
  assert.deepEqual(parseQuery("auth #cookies"), { mode: "keywords", words: ["auth", "#cookies"] });
  assert.deepEqual(parseQuery(""), { mode: "keywords", words: [] });
});
