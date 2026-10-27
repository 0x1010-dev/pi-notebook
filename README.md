# pi-notebook

Durable memory for [Pi](https://github.com/earendil-works/pi), built for a single local model that cannot afford background workers.

Everything is plain files. Nothing calls the model behind your back: memory is written by the model through dedicated tools when it decides to, when the extension nudges it, or when you ask with `/nb:wrap`.

## What it remembers

| Kind       | Test                               | Stored in                                 | Seen by the model            |
| ---------- | ---------------------------------- | ----------------------------------------- | ---------------------------- |
| preference | How you like things done, anywhere | `~/.pi/agent/AGENTS.md` (managed section) | Always                       |
| convention | A rule for this repository         | project `AGENTS.md` (managed section)     | Always                       |
| decision   | A choice between real alternatives | `.pi/notebook/decisions/`                 | Title always, body on demand |
| lesson     | A non-obvious problem and its fix  | `.pi/notebook/lessons/`                   | Title always, body on demand |
| note       | How the project's code works       | `.pi/notebook/notes/`                     | Title always, body on demand, flagged when its code changes |
| environment | A fact about your machine or accounts, true in every repo | `~/.pi/agent/pi-notebook/global/lessons/` | Title always, body on demand |
| handoff    | Current goal, status, next steps   | `.pi/notebook/handoff.md` (git-ignored)   | Summary always inside the project; full via `memory_search` |

Decisions, lessons and notes always belong to the project. Facts about your own setup (machines, accounts, shell, installed tools) are saved as `environment` entries, which are global and shown in every project; you confirm each one. Older global decisions stay readable.

A note records the commit it was saved at and, optionally, the files it describes. When the model reads a note, it is told if those files changed since (including uncommitted edits), or how many commits ago the note was saved when no files are listed.

Projects are git roots. A project gets a notebook only when you run `/nb:init` or when the model first saves something there and you accept.

## Tools (for the model)

- `memory_save`: save a preference, convention, decision, lesson, note or environment fact. Preferences, conventions and environment entries ask you to confirm. Saves are rejected when they look like they contain secrets or when a similar entry already exists. Pass `ref` to update an existing entry in place (same ref). Over-long titles are shortened and missing note paths dropped, with a note in the result.
- `memory_search`: keyword search, full entries by ref (`"D3 ~L1 N2"`), `"*"` to list every entry (with a one-line handoff pointer), or `"handoff"` for the full project handoff.
- `handoff_update`: update the project handoff. Fields left out keep their current value; the result echoes the saved handoff.
- `memory_retire`: retire decisions, lessons, notes or environment entries that no longer apply and have no replacement. You confirm. Retired entries leave the index, recall and duplicate checks but stay on file and in search results, marked with the reason. To remove one for good, delete its file yourself.

The model cannot read or edit notebook files directly; those tool calls are blocked (for shell commands, the whole command is blocked and the model is told to rerun the other parts). Changes to the managed section of `AGENTS.md` are allowed but flagged.

## How the model uses it

### Starting a session

| When                                                         | What is used                                      | Result                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A session opens inside a project                             | Nothing; injected automatically                   | The system prompt holds the handoff summary (goal, first next step), decision and lesson titles, preferences and conventions. You see a short notice with the goal, status, next step, blockers and entry counts. |
| You ask "where did we leave off?", "continue", "what's next" | Nothing; attached automatically, once per session | The full handoff arrives as a hidden note, so the model answers from it without a tool call.                                  |
| The model needs the plan later in the session                | `memory_search "handoff"`                         | The current handoff, including updates made earlier in this session.                                                          |

### While working

| When                                                                 | What is used                                     | Result                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| Your prompt mentions something recorded before                       | Nothing; attached automatically (`autoRecall`)   | Matching entries arrive as a hidden note.                                 |
| A title in the index looks relevant ("D3 auth uses session cookies") | `memory_search "D3"`                             | The full entry.                                                          |
| The model is unsure whether something was recorded                   | `memory_search "postgres restart"` or `"*"`      | Matching entries, or everything with the handoff first.                   |
| You agree on a plan                                                  | `handoff_update` with goal, status, next steps   | The plan survives the session.                                            |
| The model finishes a piece of work                                   | `handoff_update` with only the changed fields    | Status and next steps stay current; untouched fields keep their value.    |
| The model picks SQLite over Postgres for a reason                    | `memory_save` kind `decision`                    | A project entry with context, choice and consequences.                     |
| A failing build turns out to need a cache clear                      | `memory_save` kind `lesson`                      | A project entry with symptom, cause and fix.                                 |
| A fix is about your machine, not the project ("brew postgres needs a restart") | `memory_save` kind `environment` | You confirm; it shows in every project.                                |
| The model works out how part of the code fits together              | `memory_save` kind `note` with `files`           | A project note ("api: handlers wrap withAuth, routes in src/routes"), titled by area. |
| The model reads a note whose files changed since                     | `memory_search "N2"`                             | The note comes with "May be outdated: src/routes/a.ts changed since a1b2c3d". |
| You say "always use pnpm"                                            | `memory_save` kind `preference`                  | You confirm; it lands in `~/.pi/agent/AGENTS.md`.                         |
| You say "this repo keeps ARCHITECTURE.md current"                    | `memory_save` kind `convention`                  | You confirm; it lands in the project `AGENTS.md`.                         |
| An entry is outdated or duplicated                                   | `memory_save` with `ref: "D3"`                  | The entry is rewritten in place and keeps its ref.    |
| An entry no longer applies and nothing replaces it                   | `memory_retire` with refs and a reason           | You confirm; it leaves the index and stays on file as retired.            |
| The model tries `cat .pi/notebook/handoff.md`                        | Blocked by the guard                             | It is told to use `memory_search` instead.                                |

### Reminders and wrapping up

| When                                                                                               | What is used                                     | Result                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| The model commits, recovers from repeated errors, goes long without saving, or has no handoff yet | A hidden nudge                                   | At its next stopping point the model records what is worth keeping, or ignores the nudge. |
| Context usage passes `wrapAtContextPercent`                                                        | A hidden nudge                                   | The model saves before details are lost to compaction.                                     |
| You run `/nb:learn` or `/nb:learn error handling`                                                  | `memory_search "*"`, a bounded look at the repo, then `memory_save` | Notes on how the code works and proposed conventions (you confirm each), skipping what AGENTS.md and existing docs cover. |
| You run `/nb:wrap`                                                                                 | `memory_save` for each item, then `handoff_update` | The session is closed out; the next one starts from the handoff instead of git and docs. |

## Commands

| Command                  | Does                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `/nb`                    | Browse the notebook in tabs (overview, decisions, lessons, notes, global, rules). `↑↓` select or scroll, `PgUp`/`PgDn`, `←→` switch tab, `enter` opens an entry in full, `x` shows retired entries, `esc` closes |
| `/nb:init [repo\|local]` | Create a notebook for this project                         |
| `/nb:remember <text>`    | Save a preference or convention without the model          |
| `/nb:prefs`              | Edit preferences or conventions by hand                    |
| `/nb:forget <refs> [reason]` | Retire decisions, lessons or notes, e.g. `/nb:forget D3 L1 moved to docker` |
| `/nb:learn [topic]`      | Ask the model to study the repo, or one free-form topic, and record notes and conventions |
| `/nb:wrap`               | Ask the model to record decisions, lessons, notes and the handoff |
| `/nb:curate`             | Ask the model to merge duplicates (update one, retire the rest), re-check outdated notes and retire stale entries |

## Status line

`◆ NB · 3d 5l 4n · handoff updated 2h ago`

Signals are checked after every model turn. When one fires, the model gets a short hidden note asking it to act at its next natural stopping point. Signals: a commit, recovering from repeated tool errors, no handoff yet, a long stretch without saving, and context usage passing `wrapAtContextPercent` (to save before compaction). Each fires once until the next save, with a cooldown between notes.

## Settings

In `~/.pi/agent/settings.json`:

```json
{
  "notebook": {
    "storage": "repo",
    "injectBudgetTokens": 1500,
    "globalIndexLimit": 20,
    "checkpointTurns": 30,
    "handoffAfterTurns": 6,
    "nudgeCooldownTurns": 8,
    "wrapAtContextPercent": 50,
    "nudgeModel": true,
    "guard": true,
    "refreshSection": "session",
    "autoRecall": 3,
    "statusPlacement": "aboveEditor"
  }
}
```

- `storage`: default for new notebooks. `repo` keeps it in `.pi/notebook` (commit it), `local` keeps it under `~/.pi/agent/pi-notebook/projects/`.
- `refreshSection`: `session` builds the injected notebook section once per session (and after compaction or `/nb:*` commands) so the prompt prefix stays cache-friendly. `turn` rebuilds it every turn.
- `autoRecall`: how many entries matching your prompt are attached as a hidden note. `0` disables. Prompts that look like resuming work get the full handoff instead.
- `wrapAtContextPercent`: context usage that triggers a save-before-compaction nudge, once per compaction cycle. `0` disables.
- `statusPlacement`: `aboveEditor` (default) or `belowEditor` gives the status a row of its own; above the editor it stays below other widgets such as the todo panel. `footer` shares the footer status line with other extensions.

## Works well with

- [`pi-vcc`](https://www.npmjs.com/package/pi-vcc): compaction without model calls.

## Development

```sh
npm install
npm run typecheck
npm test
pi --extension ./src/index.ts
```
