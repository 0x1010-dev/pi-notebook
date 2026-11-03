# pi-notebook

Durable, readable memory for [Pi](https://github.com/earendil-works/pi), designed
for a single local model. Plain Markdown files, deterministic retrieval, no
embeddings and no background model calls.

## Three concepts

- **Rules:** explicit user instructions, always available through managed
  sections of global or project `AGENTS.md`. The user confirms additions.
- **Handoff:** one consistent snapshot of unfinished work: goal, status, next
  actions, and optional blockers and notes.
- **Memories:** useful knowledge for future work. No required categories,
  templates, summary fields, or tag hierarchy.

Good memories change a future action, prevent a likely mistake, or avoid costly
rediscovery. Put the conclusion first. Keep important rationale and verified
findings, not routine activity or a duplicate of the project's documentation.
Saving nothing is fine.

For example:

> When changing the braille renderer, use the library's canonical dot table.
> A custom row/column bit formula previously misplaced dots. Verify against
> the left-column and right-column mask tests in `src/tui/spark.rs`.

Update a memory into a complete current account when its topic changes. Do not
append a changelog or assume that a newer entry automatically overrides older
claims elsewhere. `/nb:curate` helps reconcile related memories and contradictions;
the extension does not determine truth.

## Read it like a notebook

```text
.pi/notebook/
  README.md                         generated linked index with previews and tags
  handoff.md                        current work snapshot (git-ignored)
  handoff.previous.md               one recovery copy (git-ignored, not recalled)
  memories/
    0001-braille-rendering.md
    0002-deployment-verification.md
```

Each memory has a Markdown heading, conclusion-first content, and small optional
metadata. IDs come from filenames; title, kind and status are not duplicated in
frontmatter.

```markdown
---
updated: 2026-11-02T16:00:00.000Z
tags: ["braille", "ratatui"]
files: ["src/tui/spark.rs"]
commit: a1b2c3d
---

# Braille rendering

Use the library's canonical dot table rather than a custom bit formula.

The renderer's mask tests cover the standard left and right columns.
```

Humans can edit these files directly, including headings and YAML metadata.
Lists accept JSON notation, unquoted YAML arrays such as `[braille, ratatui]`,
or indented YAML lists. Quote numeric-looking tags and commit hashes so they remain
strings. Keep numeric filename IDs unique.

A malformed file is excluded without disabling valid memories. The status line,
browser overview, generated index and search results report its path and reason;
session notifications also warn when the diagnostics change. Repair the original
file to make it available again. Conflicting IDs exclude all conflicting files,
and even malformed files reserve their numeric IDs.

The generated index links to memories, the handoff, and related source paths, and
shows saved code baselines, not live code-staleness warnings. It refreshes after
notebook writes, on changed prompt snapshots, or searches, without running Git.
Live freshness checks remain in the browser and targeted recall/search.
Do not edit the index itself. Related source links inside a
memory's own prose should be relative to that memory file.

Normal reads, listings, grep and shell browsing are allowed. The model is instructed
to use notebook tools for writes; the optional guard blocks direct `edit`/`write`
file-tool calls to notebook paths. It does not inspect or sandbox shell commands.

Projects are git roots. `/nb:init` creates a notebook, or the first project
memory save offers to create one. `local` storage keeps the same layout under
`~/.pi/agent/pi-notebook/projects/` instead of the repository.

## Tools

### `memory_save`

```json
{
  "title": "Braille rendering",
  "content": "Use the library's canonical dot table rather than a custom bit formula.",
  "tags": ["braille", "ratatui"],
  "files": ["src/tui/spark.rs"]
}
```

- Only `title` and `content` are needed for a new memory.
- Pass `ref: "M1"` to update it; omitted fields retain their values.
  Supply a complete current account when replacing content.
- Tags and project-relative files or directories are optional. Missing paths are
  retained; paths outside the project are rejected.
- `scope: "global"` stores knowledge that applies across projects and asks for
  a choice on every save or update: **Save globally**, **Save to this project
  only**, or **Reject**. Project-only is offered when inside a project. For a
  global update, project-only saves a local copy with the proposed changes and
  leaves the global original unchanged. Global refs look like `~M1`.
- `kind: "rule"` records a short explicit user instruction. Project is the default
  scope; global rules apply everywhere. The user confirms each addition, with
  the same project-only or reject choices for global rule proposals.
- Related memories are advisory: a similar title does not block saving.
- Secret-looking values are rejected. There are no hard title/content length caps.

### `memory_search`

- Keywords, including paths: `"braille renderer"` or `"src/tui/spark.rs"`.
- Exact tag constraints: `"#braille #ratatui"` requires both tags. Ordinary words
  also match tags without `#`.
- Refs: `"M1 ~M2"` reads full memories.
- `"*"` browses active memories with previews; `"handoff"` reads the full handoff.

Ranking uses normalized tokens, term rarity, and title/tag/path/content weights.
Results show previews and matching fields. Code-linked memories carry warnings
when their related paths changed, including uncommitted changes. Changing tags
alone does not renew the code-verification baseline.

### `handoff_update`

Replace the snapshot with `goal`, `status`, and `next_steps` (all required).
Optional `blockers` and `notes` are cleared when omitted. This deliberately avoids
silently retaining contradictory fragments. Empty next actions mean work is done.
The result echoes the whole handoff for review.

Replacement is atomic and preserves the previous file verbatim as
`handoff.previous.md`. Only one previous version is kept; it is not searched or
injected. Both files are Git-ignored. To recover from an incorrect update, inspect
the previous file and copy its contents back to `handoff.md` manually before another
update replaces the recovery copy. This protects against accidental replacements,
not disk loss; keep independent backups for that.

### `memory_delete`

Pass `refs` and a reason. The user must confirm permanent removal of the files.
There is no notebook archive or undo; recovery requires Git or your own backup.
Deleted IDs are not reused. Keep `.next-id` with the notebook when moving or
backing it up. Correct knowledge with `memory_save` rather than deleting it
unnecessarily, and preserve still-current facts before removing mixed-topic entries.

## Automatic behavior

The system prompt contains rules, a handoff pointer and a budgeted memory-title
index. Relevant active memories are attached to user prompts automatically.
Single-topic queries, tags, paths and strong content matches can trigger recall.
Automatic excerpts share a 6,000-character budget, put the beginning of each
memory first, and point to full entries when truncated.

Already delivered versions do not crowd out unseen matches. Updates and human
edits become eligible again; compaction clears delivery suppression. The prompt
snapshot stays stable until notebook content changes (or `refreshSection` is
`turn`). Resume-like prompts receive the full handoff once per session or
compaction cycle.

Optional hidden nudges occur at commits and as context fills up, not after arbitrary
tool failures or a quota of unsaved turns. They explicitly permit saving nothing.
There is no automatic extraction or verification by another model.

Past the compaction band, each model request carries a bare usage line such as
`Context window 74% full.` It is not stored in the session, so it neither accumulates nor
disturbs prompt caching. The suggested action is sent once when usage first crosses
each band, and again after compaction: consider saving knowledge (40%), consider
updating the handoff (55%), then update the handoff at the next clean stopping
point (70%).

### Handoff compaction

With `handoffCompaction: true` (the default), compaction uses the project handoff as its summary
instead of an LLM summary; pi still keeps its recent-message tail verbatim. The
model gets a `context_compact` tool, which only accepts a call when this session
updated the handoff within `handoffStaleTurns` turns. Compaction runs after the
response ends, then work resumes from the handoff automatically. Auto-continue
stops when the handoff has no next steps, after `maxCompactCycles`, or when the
user interrupts. If pi compacts on its own while the handoff is stale, the handoff
is still used and marked as possibly out of date; pi's recent-message tail covers
the gap. Without a handoff, pi's default compaction runs.

## Commands

| Command | Purpose |
| --- | --- |
| `/nb` | Browse Overview, Memories, Global and Rules; arrows navigate, enter expands |
| `/nb:init [repo\|local]` | Create a notebook |
| `/nb:remember <text>` | Add a user rule without the model |
| `/nb:prefs` | Edit rules |
| `/nb:forget M1 [reason]` | Permanently delete obsolete memories after confirmation |
| `/nb:wrap` | Save worthwhile knowledge and reconcile unfinished work |
| `/nb:curate` | Verify claims, reconcile contradictions and consolidate current knowledge |

The browser loads memories once per opening and caches formatted rows. Code
freshness checks run asynchronously for visible entries; “Checking code baseline…”
is replaced with the result when ready. Checks are shared within the view and
cancelled on close. Reopen `/nb` to refresh memories and code freshness after edits.

## Settings

Under `notebook` in `~/.pi/agent/settings.json`:

```json
{
  "storage": "repo",
  "injectBudgetTokens": 1500,
  "globalIndexLimit": 20,
  "nudgeCooldownTurns": 16,
  "contextBands": [40, 55, 70],
  "nudgeModel": true,
  "guard": true,
  "refreshSection": "session",
  "autoRecall": 3,
  "statusPlacement": "aboveEditor",
  "handoffCompaction": true,
  "handoffStaleTurns": 5,
  "maxCompactCycles": 20
}
```

`autoRecall: 0` disables automatic memory recall; `contextBands: []` disables the
context bands. Budgets use an approximate four characters per token,
not the model's tokenizer. Status placement also supports `belowEditor` or `footer`.

## Breaking format change

The previous decision/lesson/note collections and D/L/N refs are not read by this
version. There is no automatic migration or rewriting of existing notebooks.
Recreate or deliberately convert useful current knowledge into `memories/`;
preserve old files separately if their history matters. The handoff format and
tool arguments changed too.

### One-off staged converter

From a checkout of this repository, first preview the conversion without writing:

```sh
npm run migrate -- --source /path/to/project/.pi/notebook
```

To create a separate staging directory, explicitly add `--write` and a fresh output:

```sh
npm run migrate -- \
  --source /path/to/project/.pi/notebook \
  --rules /path/to/project/AGENTS.md \
  --output /path/to/notebook-review \
  --write
```

Use `--scope global` when converting a global notebook. Convert project and global
notebooks separately; cross-scope references are flagged for manual reconciliation.
The source notebook is never modified, and output cannot exist already or be inside
the source notebook (including through symlinked parents).

Staging contains:

- `notebook/`: active entries in the new format, plus a translated handoff and index.
- `originals/`: verbatim legacy entries (including historical ones), the handoff,
  and optionally the supplied rules file. This is **not** a full notebook backup.
- `reference-map.json`: old-to-new IDs for converted active entries.
- `provenance.json`: original metadata, source paths and content hashes.
- `REVIEW.md`: review checklist, historical entries and unresolved-reference warnings.

The converter preserves content, dates and code baselines; it does not invent tags,
verify claims, merge topics, correct contradictions or install rules. References to
converted active entries are rewritten; historical, missing and cross-scope refs
remain visible with warnings. Review replacements even inside code examples, since
reference rewriting is textual. Old handoff headings are translated, not reconciled.

Read `REVIEW.md`, curate by topic, verify useful claims and test representative
searches. Back up the entire live notebook and rules independently before manually
installing the reviewed `notebook/` contents. Keep the originals for rollback.
Nothing is activated automatically.

The live notebook keeps current knowledge only. Existing `archive/` directories
from an earlier version are not read, searched or deleted automatically; move
them outside the notebook or remove them after reviewing your backups. Migration
`originals/` are likewise review/rollback material, not a permanent memory tier.

## Development and evaluation

```sh
npm install
npm run typecheck
npm test
pi --extension ./src/index.ts
```

Tests cover storage, registered tools, human edits, confirmed deletion, recall delivery,
compaction, budgets, and browser rendering. A small synthetic retrieval evaluation
enforces Recall@3 >= 0.90 and irrelevant-injection rate <= 0.20. It is a regression
check, not a model benchmark. Lexical retrieval can still miss paraphrases with no
shared words or tags, and it cannot resolve contradictory knowledge itself.

For local-model evaluation, compare no notebook, handoff only, and the complete
extension on real future tasks. Measure avoided mistakes and rediscovery, irrelevant
injections, tokens, and bookkeeping tool calls—not merely the number of memories.
