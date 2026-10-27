import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findSecret } from "../validate.ts";

/** Notifies and returns true when `value` looks like it contains a secret. */
export function rejectSecret(ctx: ExtensionContext, value: string): boolean {
  const secret = findSecret(value);
  if (!secret) return false;
  ctx.ui.notify(`Not saved: looks like it contains a ${secret}.`, "error");
  return true;
}

/** Ask whether a rule applies everywhere or to one project. `undefined` if dismissed. */
export async function pickRuleTarget(
  ctx: ExtensionContext,
  title: string,
  everywhere: string,
  projectOnly: string,
): Promise<"everywhere" | "project" | undefined> {
  const choice = await ctx.ui.select(title, [everywhere, projectOnly]);
  if (!choice) return undefined;
  return choice === projectOnly ? "project" : "everywhere";
}
