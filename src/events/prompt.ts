import { buildSnapshot, syncContextFile } from "../context-files.ts";
import { NUDGE_TYPE, RECALL_BODY_CHARS } from "../constants.ts";
import { clip, entryLabel, noteLines } from "../format.ts";
import { formatHandoff } from "../inject.ts";
import { locate, type Located, type Runtime } from "../runtime.ts";
import type { Session } from "../session.ts";
import {
  looksLikePreference,
  looksLikeResume,
  type NudgeKind,
  nudgeText,
  PREFERENCE_NUDGE,
} from "../signals.ts";
import { readHandoff, recall, ref } from "../store.ts";

/** Hidden notes for the model: nudges, a resume handoff, or entries relevant to the prompt. */
function promptNotes(
  session: Session,
  { scope, global }: Located,
  cwd: string,
  prompt: string,
  queued: NudgeKind | undefined,
): string[] {
  const { cfg } = session;
  const notes: string[] = [];
  if (cfg.nudgeModel && looksLikePreference(prompt))
    notes.push(PREFERENCE_NUDGE);
  if (cfg.nudgeModel && queued) notes.push(nudgeText(queued));

  const resume =
    scope && !session.handoffShown && looksLikeResume(prompt)
      ? readHandoff(scope)
      : undefined;
  if (resume) {
    session.handoffShown = true;
    notes.push(
      `[pi-notebook] The prompt looks like resuming work. Full project handoff:\n\n${formatHandoff(resume)}`,
    );
    return notes;
  }

  const hits = recall(
    scope ? [scope, global] : [global],
    prompt,
    cfg.autoRecall,
  ).filter((e) => !session.recalled.has(ref(e)));
  if (hits.length) {
    for (const e of hits) session.recalled.add(ref(e));
    const entries = hits.map((e) =>
      [entryLabel(e), ...noteLines(cwd, e), clip(e.body, RECALL_BODY_CHARS)].join("\n"),
    );
    notes.push(
      `[pi-notebook] Possibly relevant notebook entries. Use them if they apply, ignore them otherwise.\n\n${entries.join("\n\n")}`,
    );
  }
  return notes;
}

export function registerPromptEvents({ pi, session }: Runtime): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const located = locate(ctx.cwd);
    if (!session.snapshot || session.cfg.refreshSection === "turn")
      session.snapshot = buildSnapshot(located, session.cfg);
    const opts = event.systemPromptOptions;
    opts.sections.notebook = session.snapshot.section;
    for (const f of session.snapshot.files)
      syncContextFile(opts.contextFiles, f);

    const suppress = session.suppressNudgeOnce;
    session.suppressNudgeOnce = false;
    const queued = session.pendingNudge;
    session.pendingNudge = undefined;
    if (suppress || event.messageType !== "user") return;

    const notes = promptNotes(session, located, ctx.cwd, event.prompt, queued);
    if (notes.length === 0) return;
    return {
      message: {
        customType: NUDGE_TYPE,
        content: notes.join("\n\n"),
        display: false,
      },
    };
  });
}
