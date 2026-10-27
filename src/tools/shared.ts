import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const text = (t: string) => [{ type: "text" as const, text: t }];

/** Models sometimes pass list arguments as one comma or space separated string. */
export function splitListArgs(args: unknown, keys: string[]): never {
  const a = { ...(args as Record<string, unknown>) };
  for (const key of keys) {
    const v = a[key];
    if (typeof v === "string") a[key] = v.split(/[\s,]+/).filter(Boolean);
  }
  return a as never;
}

/** Tool-call row: `notebook <verb> <detail>`; `detail` is already themed. */
export function callRow(theme: Theme, verb: string, detail: string): Text {
  return new Text(
    `${theme.fg("toolTitle", theme.bold("notebook "))}${theme.fg("muted", verb)} ${detail}`,
    0,
    0,
  );
}

export const textRow = (s: string): Text => new Text(s, 0, 0);
