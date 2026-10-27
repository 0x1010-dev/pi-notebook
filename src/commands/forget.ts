import { retireRefs } from "../flows/retire.ts";
import type { Scope } from "../paths.ts";
import { locate, type Runtime } from "../runtime.ts";
import { listAll, parseRef, ref } from "../store.ts";

export function registerForgetCommand(rt: Runtime): void {
  rt.pi.registerCommand("nb:forget", {
    description:
      "Retire notebook decisions, lessons or notes, e.g. /nb:forget D3 L1 no longer true",
    getArgumentCompletions: (prefix) => {
      if (/\s/.test(prefix.trimStart())) return [];
      const { scope, global } = locate(process.cwd());
      const want = prefix.trim().toLowerCase();
      return [scope, global]
        .filter((s): s is Scope => !!s)
        .flatMap((s) => listAll(s))
        .filter(
          (e) => e.status === "active" && ref(e).toLowerCase().startsWith(want),
        )
        .map((e) => ({ value: ref(e), label: `${ref(e)} ${e.title}` }));
    },
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const n = words.findIndex((w) => !parseRef(w));
      const refs = n < 0 ? words : words.slice(0, n);
      if (refs.length === 0) {
        ctx.ui.notify(
          "Usage: /nb:forget <refs> [reason], e.g. /nb:forget D3 no longer true",
          "warning",
        );
        return;
      }
      const reason = n < 0 ? "" : words.slice(n).join(" ");
      const r = await retireRefs(rt, ctx, refs, reason);
      if (!r.declined)
        ctx.ui.notify(`◆ ${r.message}`, r.retired.length ? "info" : "warning");
    },
  });
}
