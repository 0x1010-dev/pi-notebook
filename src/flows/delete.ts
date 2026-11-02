import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  type Entry,
  getEntry,
  oneLine,
  parseRef,
  ref,
  deleteEntry,
} from "../store.ts";
import { findSecret, secretError } from "../validate.ts";

export interface DeleteResult {
  deleted: string[];
  declined: boolean;
  message: string;
}

/** Delete only explicitly resolved memories after user confirmation. */
export async function deleteRefs(
  rt: Runtime,
  ctx: ExtensionContext,
  words: string[],
  reason: string,
): Promise<DeleteResult> {
  if (!ctx.hasUI) throw new Error("Deleting memories needs user confirmation, unavailable in this mode.");
  const secret = findSecret(reason);
  if (secret) throw new Error(secretError(secret));
  const { scope, global } = locate(ctx.cwd);
  const found: { scope: Scope; entry: Entry }[] = [];
  const missing: string[] = [];
  for (const w of words) {
    const r = parseRef(w);
    const s = r?.global ? global : scope;
    const e = r && s ? getEntry(s, r.id) : undefined;
    if (!e || !s) missing.push(w);
    else if (!found.some((f) => f.entry.path === e.path))
      found.push({ scope: s, entry: e });
  }
  const skipped = [
    ...(missing.length ? [`Not found: ${missing.join(", ")}.`] : []),
  ];
  if (found.length === 0)
    return {
      deleted: [],
      declined: false,
      message: skipped.join(" ") || "Nothing to delete.",
    };
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      `◆ Permanently delete ${found.length === 1 ? "this memory" : `${found.length} memories`}?`,
      `${found.map(({ entry }) => `${ref(entry)} ${entry.title}`).join("\n")}${reason ? `\n\nReason: ${oneLine(reason)}` : ""}\n\nFiles will be removed. There is no notebook archive or undo; recovery requires Git or your own backup.`,
    );
    if (!ok)
      return {
        deleted: [],
        declined: true,
        message: "The user declined. Do not retry.",
      };
  }
  for (const { scope: s, entry } of found)
    deleteEntry(s, entry.id);
  rt.session.invalidate();
  rt.refreshStatus(ctx);
  const deleted = found.map(({ entry }) => ref(entry));
  return {
    deleted,
    declined: false,
    message: [`Deleted ${deleted.join(", ")}.`, ...skipped].join(" "),
  };
}
