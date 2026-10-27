export const STATUS_KEY = "notebook";
export const NUDGE_TYPE = "notebook-nudge";

/** Agent runs a status hint stays visible before it expires. */
export const HINT_TTL_RUNS = 5;

/** A handoff updated within this window is not re-suggested after compaction. */
export const HANDOFF_FRESH_MS = 10 * 60_000;

/** Max characters of an entry body attached by auto-recall. */
export const RECALL_BODY_CHARS = 600;

/** Max characters of a global entry body shown in its confirmation dialog. */
export const CONFIRM_PREVIEW_CHARS = 400;
