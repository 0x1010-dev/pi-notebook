import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSnapshot, loadNotebook, notebookFingerprint } from "./context-files.ts";
import { RECALL_BUDGET_CHARS } from "./constants.ts";
import { promptNotes } from "./events/prompt.ts";
import { buildSection } from "./inject.ts";
import type { Scope } from "./paths.ts";
import { Session } from "./session.ts";
import { listAll, readHandoff, readManaged, recall, ref, refreshIndex, saveEntry, updateEntry, writeHandoff } from "./store.ts";

const root = mkdtempSync(join(tmpdir(), "nb-recall-"));
after(() => rmSync(root, { recursive: true }));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
let next = 0;
function fixture() {
  const project = { root: join(root, String(++next)), name: "fixture" };
  const scope: Scope = { kind: "project", dir: join(project.root, ".pi/notebook"),
    agentsFile: join(project.root, "AGENTS.md"), project, mode: "repo" };
  const global: Scope = { kind: "global", dir: join(project.root, "global"),
    agentsFile: join(project.root, "global", "AGENTS.md") };
  const session = new Session();
  session.reset();
  return { located: { project, scope, global }, session };
}

test("recall delivers the next unseen result, updated content, and memories lost to compaction", () => {
  const { located, session } = fixture();
  const a = saveEntry(located.scope, "SQLite migrations", "SQLite migrations require transactions.");
  const b = saveEntry(located.scope, "SQLite backups", "SQLite backups use the backup API.");
  session.cfg.autoRecall = 1;
  const first = promptNotes(session, located, located.project.root, "sqlite", undefined).join("\n");
  assert.ok(first.includes(ref(a)) || first.includes(ref(b)));
  assert.equal(session.recalled.size, 1);
  const second = promptNotes(session, located, located.project.root, "sqlite", undefined).join("\n");
  assert.equal(session.recalled.size, 2);
  assert.notEqual(first, second);
  assert.deepEqual(promptNotes(session, located, located.project.root, "sqlite", undefined), []);
  updateEntry(located.scope, a.id, { body: "SQLite migrations use an exclusive transaction." });
  assert.match(promptNotes(session, located, located.project.root, "sqlite", undefined).join("\n"), /exclusive transaction/);
  session.onCompact();
  assert.ok(promptNotes(session, located, located.project.root, "sqlite", undefined).length);
});

test("conclusion-first recalled content and metadata share a bounded budget", () => {
  const { located, session } = fixture();
  for (let i = 0; i < 3; i++)
    saveEntry(located.scope, `Braille plotting ${i}`, `Use the canonical dot table ${i}.\n\n${"Incident details. ".repeat(600)}`,
      { tags: ["braille"] });
  const note = promptNotes(session, located, located.project.root, "braille", undefined).join("\n");
  for (let i = 0; i < 3; i++) assert.match(note, new RegExp(`Use the canonical dot table ${i}`));
  assert.match(note, /Read M\d for the full memory/);
  const heading = note.indexOf("\n\n") + 2;
  assert.ok(note.slice(heading).length <= RECALL_BUDGET_CHARS);
  assert.equal(session.recalled.size, 3);
});

test("human edits change fingerprints and new snapshots without rewriting memory files", () => {
  const { located } = fixture();
  const e = saveEntry(located.scope, "Original", "A useful conclusion.");
  const before = notebookFingerprint(located);
  writeFileSync(e.path, "# Human-edited title\n\nA better conclusion.\n");
  assert.notEqual(notebookFingerprint(located), before);
  assert.equal(listAll(located.scope)[0].title, "Human-edited title");
  assert.match(buildSection({ ...located, budgetTokens: 1500, globalLimit: 20 }), /Human-edited title/);
});

test("resuming work supplies the handoff without suppressing relevant durable knowledge", () => {
  const { located, session } = fixture();
  saveEntry(located.scope, "Braille rendering", "Use the canonical dot table.");
  writeHandoff(located.scope, {
    goal: "Improve charts", status: "Implementation pending", nextSteps: ["Fix braille"],
    blockers: [], notes: "", updated: "2026-11-02T12:00:00.000Z",
  });
  const notes = promptNotes(session, located, located.project.root, "Continue braille rendering", undefined).join("\n");
  assert.match(notes, /Full project handoff/);
  assert.match(notes, /canonical dot table/);
});

test("injected indexes respect the approximate character budget even for oversized fields", () => {
  const { located } = fixture();
  saveEntry(located.scope, "Long title ".repeat(300), "Useful content.");
  for (const budgetTokens of [0, 20, 200, 1500]) {
    const section = buildSection({ ...located, budgetTokens, globalLimit: 20 });
    assert.ok(section.length <= budgetTokens * 4);
  }
});

test("global index limits select the most recently updated memories", () => {
  const { located } = fixture();
  const older = saveEntry(located.global, "Older", "Old knowledge.", {}, new Date("2020-01-01"));
  const newer = saveEntry(located.global, "Newer", "New knowledge.", {}, new Date("2026-01-01"));
  const input = { ...located, budgetTokens: 1500, globalLimit: 1 };
  assert.match(buildSection(input), /~M2 Newer/);
  assert.doesNotMatch(buildSection(input), /~M1 Older/);
  updateEntry(located.global, older.id, { title: "Updated" }, new Date("2026-11-01"));
  assert.match(buildSection(input), /~M1 Updated/);
  assert.doesNotMatch(buildSection(input), new RegExp(`${ref(newer)} Newer`));
});

test("malformed handoffs are diagnosed without blocking valid memories", () => {
  const { located, session } = fixture();
  saveEntry(located.scope, "Valid memory", "Useful knowledge.");
  const path = join(located.scope.dir, "handoff.md");
  writeFileSync(path, "---\nupdated: [broken\n---\n# Current handoff\n");
  const loaded = loadNotebook(located);
  assert.equal(loaded.handoff, undefined);
  assert.equal(readHandoff(located.scope), undefined);
  assert.deepEqual(loaded.diagnostics.map((diagnostic) => diagnostic.path), [path]);
  assert.equal(loaded.projectEntries.length, 1);
  assert.match(buildSnapshot(located, session.cfg, loaded).section, /Valid memory/);
  assert.match(buildSnapshot(located, session.cfg, loaded).section, /Notebook warning/);
});

test("injection can reuse a complete view snapshot without reading notebook files again", () => {
  const { located } = fixture();
  saveEntry(located.scope, "Snapshot memory", "Use the loaded notebook snapshot.");
  writeHandoff(located.scope, {
    goal: "Open notebook", status: "Ready", nextSteps: ["Browse"],
    blockers: [], notes: "", updated: "2026-11-02T12:00:00.000Z",
  });
  const input = { ...located, budgetTokens: 1500, globalLimit: 20 };
  const expected = buildSection(input);
  const snapshot = {
    projectEntries: listAll(located.scope), globalEntries: listAll(located.global),
    handoff: readHandoff(located.scope), conventions: readManaged(located.scope.agentsFile),
  };
  rmSync(located.project.root, { recursive: true });
  assert.equal(buildSection({ ...input, snapshot }), expected);
});

test("fingerprinting, index generation, injection and recall share one loaded collection", () => {
  const { located, session } = fixture();
  saveEntry(located.scope, "Snapshot memory", "Use the loaded collection.");
  writeFileSync(join(located.scope.dir, "memories/0042-broken.md"), "No heading.");
  const loaded = loadNotebook(located);
  const fingerprint = notebookFingerprint(located, loaded);
  const snapshot = buildSnapshot(located, session.cfg, loaded);
  const expected = promptNotes(session, located, located.project.root, "snapshot", undefined, loaded);
  session.recalled.clear();
  rmSync(join(located.scope.dir, "memories"), { recursive: true });
  assert.equal(notebookFingerprint(located, loaded), fingerprint);
  assert.deepEqual(buildSnapshot(located, session.cfg, loaded), snapshot);
  assert.deepEqual(promptNotes(session, located, located.project.root, "snapshot", undefined, loaded), expected);
  refreshIndex(located.scope, loaded.local);
  const index = join(located.scope.dir, "README.md");
  assert.match(readFileSync(index, "utf8"), /Snapshot memory/);
  assert.match(readFileSync(index, "utf8"), /0042-broken/);
  const modified = statSync(index).mtimeMs;
  refreshIndex(located.scope, loaded.local);
  assert.equal(statSync(index).mtimeMs, modified, "unchanged indexes must not be rewritten");
});

test("small realistic retrieval evaluation meets recall and irrelevant-injection thresholds", (t) => {
  const { located } = fixture();
  const s = located.scope;
  const braille = saveEntry(s, "Braille rendering", "Use the canonical library dot table; custom bit formulas misplace dots.", {
    tags: ["braille", "ratatui"], files: ["src/tui/spark.rs"],
  });
  const width = saveEntry(s, "Terminal text width", "Measure terminal cells rather than counting characters when fitting labels.", {
    tags: ["ratatui", "unicode"], files: ["src/tui/render.rs"],
  });
  const energy = saveEntry(s, "Energy accounting", "Accumulate total energy in the daemon. The client computes only window averages.", {
    tags: ["energy"], files: ["src/daemon/accum.rs"],
  });
  const deploy = saveEntry(s, "Deployment verification", "After installing a new binary, compare running executable bytes and restart the service when different.", {
    tags: ["deployment", "systemd"],
  });
  const tests = saveEntry(s, "CLI integration tests", "Spawn the real binary and test structure with fake input, not exact live readings.", {
    tags: ["testing"], files: ["tests/wire.rs"],
  });
  saveEntry(s, "Parser rationale", "Handwritten parsers support learning and isolated fixture tests.");
  const cases = [
    { query: "braille", relevant: [braille.id] },
    { query: "Fix jagged braille dots", relevant: [braille.id] },
    { query: "#ratatui #braille", relevant: [braille.id] },
    { query: "src/tui/spark.rs", relevant: [braille.id] },
    { query: "Terminal labels clip characters", relevant: [width.id] },
    { query: "Where does total energy accumulate?", relevant: [energy.id] },
    { query: "Verify deployment of the new binary", relevant: [deploy.id] },
    { query: "Add CLI integration tests", relevant: [tests.id] },
    { query: "weather forecast", relevant: [] },
    { query: "subscription invoices", relevant: [] },
  ];
  let retrievedRelevant = 0, expectedRelevant = 0, irrelevant = 0, retrieved = 0;
  for (const c of cases) {
    const hits = recall([s], c.query, 3);
    for (const id of c.relevant) {
      expectedRelevant++;
      if (hits.some((e) => e.id === id)) retrievedRelevant++;
    }
    retrieved += hits.length;
    irrelevant += hits.filter((e) => !c.relevant.includes(e.id)).length;
    if (!c.relevant.length) assert.deepEqual(hits, [], c.query);
  }
  const recallAt3 = retrievedRelevant / expectedRelevant;
  const irrelevantRate = irrelevant / Math.max(1, retrieved);
  t.diagnostic(`Recall@3=${recallAt3.toFixed(2)}, irrelevant-injection rate=${irrelevantRate.toFixed(2)} across ${cases.length} synthetic queries`);
  assert.ok(recallAt3 >= 0.9, `Recall@3 ${recallAt3} < 0.9`);
  assert.ok(irrelevantRate <= 0.2, `Irrelevant injection ${irrelevantRate} > 0.2`);
});
