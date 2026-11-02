import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import {
  type Entry,
  getEntry,
  oneLine,
  parseRef,
  ref,
  retireEntry,
} from "../store.ts";
import { findSecret, secretError } from "../validate.ts";

export interface RetireResult {
  retired: string[];
  declined: boolean;
  message: string;
}

/** Confirm with the user, then retire the active entries among `words`. */
export async function retireRefs(
  rt: Runtime,
  ctx: ExtensionContext,
  words: string[],
  reason: string,
): Promise<RetireResult> {
  const secret = findSecret(reason);
  if (secret) throw new Error(secretError(secret));
  const { scope, global } = locate(ctx.cwd);
  const found: { scope: Scope; entry: Entry }[] = [];
  const missing: string[] = [];
  const inactive: string[] = [];
  for (const w of words) {
    const r = parseRef(w);
    const s = r?.global ? global : scope;
    const e = r && s ? getEntry(s, r.id) : undefined;
    if (!e || !s) missing.push(w);
    else if (e.status !== "active") inactive.push(`${ref(e)} (${e.status})`);
    else if (!found.some((f) => f.entry.path === e.path))
      found.push({ scope: s, entry: e });
  }
  const skipped = [
    ...(missing.length ? [`Not found: ${missing.join(", ")}.`] : []),
    ...(inactive.length ? [`Already inactive: ${inactive.join(", ")}.`] : []),
  ];
  if (found.length === 0)
    return {
      retired: [],
      declined: false,
      message: skipped.join(" ") || "Nothing to retire.",
    };
  if (ctx.hasUI) {
    const ok = await ctx.ui.confirm(
      `◆ Retire ${found.length === 1 ? "this entry" : `${found.length} entries`}?`,
      `${found.map(({ entry }) => `${ref(entry)} ${entry.title}`).join("\n")}${reason ? `\n\nReason: ${oneLine(reason)}` : ""}`,
    );
    if (!ok)
      return {
        retired: [],
        declined: true,
        message: "The user declined. Do not retry.",
      };
  }
  for (const { scope: s, entry } of found)
    retireEntry(s, entry.id, reason);
  rt.session.invalidate();
  rt.refreshStatus(ctx);
  const retired = found.map(({ entry }) => ref(entry));
  return {
    retired,
    declined: false,
    message: [`Retired ${retired.join(", ")}.`, ...skipped].join(" "),
  };
}
