import { NUDGE_TYPE, RECALL_BUDGET_CHARS } from "../constants.ts";
import { buildSnapshot, loadNotebook, notebookFingerprint, syncContextFile } from "../context-files.ts";
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
import { diagnosticText, readHandoff, recall, ref, refreshIndex, revision } from "../store.ts";

/** Hidden notes for the model: nudges, a resume handoff, or entries relevant to the prompt. */
export function promptNotes(
  session: Session,
  { scope, global }: Located,
  cwd: string,
  prompt: string,
  queued: NudgeKind | undefined,
  loaded?: ReturnType<typeof loadNotebook>,
): string[] {
  const { cfg } = session;
  const notes: string[] = [];
  if (cfg.nudgeModel && looksLikePreference(prompt))
    notes.push(PREFERENCE_NUDGE);
  if (cfg.nudgeModel && queued) notes.push(nudgeText(queued));

  const resume =
    scope && !session.handoffShown && looksLikeResume(prompt)
      ? loaded ? loaded.handoff : readHandoff(scope)
      : undefined;
  if (resume) {
    session.handoffShown = true;
    notes.push(
      `[pi-notebook] The prompt looks like resuming work. Full project handoff:\n\n${formatHandoff(resume)}`,
    );
  }

  const hits = recall(
    scope ? [scope, global] : [global],
    prompt,
    cfg.autoRecall,
    (e) => session.recalled.get(ref(e)) === revision(e),
    loaded ? [...loaded.projectEntries, ...loaded.globalEntries] : undefined,
  );
  if (hits.length) {
    let remaining = RECALL_BUDGET_CHARS;
    const entries: string[] = [];
    for (const [i, e] of hits.entries()) {
      const heading = [entryLabel(e), ...noteLines(cwd, e)].join("\n");
      const allowance = Math.floor(remaining / (hits.length - i));
      if (heading.length + 80 > allowance) continue;
      const body = clip(e.body, allowance - heading.length - 80);
      const more = body === e.body ? "" : `\nRead ${ref(e)} for the full memory.`;
      const rendered = `${heading}\n${body}${more}`;
      if (rendered.length + 2 > remaining) continue;
      entries.push(rendered);
      remaining -= rendered.length + 2;
      session.recalled.set(ref(e), revision(e));
    }
    if (!entries.length) return notes;
    notes.push(
      `[pi-notebook] Possibly relevant notebook entries. Use them if they apply, ignore them otherwise.\n\n${entries.join("\n\n")}`,
    );
  }
  return notes;
}

export function registerPromptEvents({ pi, session }: Runtime): void {
  pi.on("before_agent_start", async (event, ctx) => {
    const located = locate(ctx.cwd);
    const loaded = loadNotebook(located);
    const warnings = diagnosticText(loaded.diagnostics);
    if (warnings !== session.loadWarning) {
      session.loadWarning = warnings;
      if (warnings) ctx.ui.notify(warnings, "warning");
    }
    const fingerprint = notebookFingerprint(located, loaded);
    if (session.snapshot && session.snapshotFingerprint !== fingerprint)
      session.handoffShown = false;
    if (!session.snapshot || session.cfg.refreshSection === "turn" ||
        session.snapshotFingerprint !== fingerprint) {
      if (located.scope && loaded.local) refreshIndex(located.scope, loaded.local);
      refreshIndex(located.global, loaded.everywhere);
      session.snapshot = buildSnapshot(located, session.cfg, loaded);
      session.snapshotFingerprint = fingerprint;
    }
    const opts = event.systemPromptOptions;
    opts.sections.notebook = session.snapshot.section;
    for (const f of session.snapshot.files)
      syncContextFile(opts.contextFiles, f);

    const suppress = session.suppressNudgeOnce;
    session.suppressNudgeOnce = false;
    const queued = session.pendingNudge;
    session.pendingNudge = undefined;
    if (suppress || event.messageType !== "user") return;

    const notes = promptNotes(session, located, ctx.cwd, event.prompt, queued, loaded);
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
