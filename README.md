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
| handoff    | Current goal, status, next steps   | `.pi/notebook/handoff.md` (git-ignored)   | Always, inside the project   |

Decisions and lessons can also be global (`~/.pi/agent/pi-notebook/global/`), but only for facts about your own setup that matter across projects (machines, accounts, shell, installed tools). Everything learned in a project stays there; `/nb:curate` can promote an entry to global later.

Projects are git roots. A project gets a notebook only when you run `/nb:init` or when the model first saves something there and you accept.

## Tools (for the model)

- `memory_save`: save a preference, convention, decision or lesson. Preferences, conventions and global entries ask you to confirm. Saves are rejected when they look like they contain secrets, when decisions or lessons lack their sections (Context/Decision/Consequences, Symptom/Cause/Fix), or when a similar entry already exists.
- `memory_search`: keyword search, full entries by ref (`"D3 ~L1"`), or `"*"` to list everything.
- `handoff_update`: replace the project handoff.
- `suggest_command`: put a `/nb:*` tip in the status line. Never interrupts.

The model cannot read or edit notebook files directly; those tool calls are blocked. Changes to the managed section of `AGENTS.md` are allowed but flagged.

## Commands

| Command                  | Does                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `/nb`                    | Show the notebook                                          |
| `/nb:init [repo\|local]` | Create a notebook for this project                         |
| `/nb:remember <text>`    | Save a preference or convention without the model          |
| `/nb:prefs`              | Edit preferences or conventions by hand                    |
| `/nb:wrap`               | Ask the model to record decisions, lessons and the handoff |
| `/nb:curate`             | Ask the model to merge duplicates and retire stale entries |

## Status line

`◆ 📓 · 3d 5l · handoff updated 2h ago · Tip: /nb:wrap to record finished work`

Signals are checked after every model turn. When one fires, the model gets a short hidden note (asking it to act at its next natural stopping point) and the status line shows a tip. Signals: a commit or completed todo, recovering from repeated tool errors, no handoff yet, a long stretch without saving, and context usage passing `wrapAtContextPercent` (to save before compaction). Each fires once until the next save, with a cooldown between notes.

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
    "curateAfter": 10,
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
- `autoRecall`: how many entries matching your prompt are attached as a hidden note. `0` disables.
- `wrapAtContextPercent`: context usage that triggers a save-before-compaction nudge, once per compaction cycle. `0` disables.
- `statusPlacement`: `aboveEditor` (default) or `belowEditor` gives the status a row of its own; above the editor it stays below other widgets such as the todo panel. `footer` shares the footer status line with other extensions.

## Works well with

- [`@juicesharp/rpiv-todo`](https://www.npmjs.com/package/@juicesharp/rpiv-todo): open todos are copied into the handoff automatically.
- [`pi-vcc`](https://www.npmjs.com/package/pi-vcc): compaction without model calls.

## Development

```sh
npm install
npm run typecheck
npm test
pi --extension ./src/index.ts
```
