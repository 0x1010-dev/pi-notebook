import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerForgetCommand } from "./commands/forget.ts";
import { registerInitCommand } from "./commands/init.ts";
import { registerPromptCommands } from "./commands/prompts.ts";
import { registerPrefsCommand, registerRememberCommand } from "./commands/rules.ts";
import { registerShowCommand } from "./commands/show.ts";
import { registerPromptEvents } from "./events/prompt.ts";
import { registerSessionEvents } from "./events/session.ts";
import { registerToolEvents } from "./events/tools.ts";
import { registerTurnEvents } from "./events/turns.ts";
import { createRuntime } from "./runtime.ts";
import { registerHandoffUpdate } from "./tools/handoff-update.ts";
import { registerMemoryRetire } from "./tools/memory-retire.ts";
import { registerMemorySave } from "./tools/memory-save.ts";
import { registerMemorySearch } from "./tools/memory-search.ts";

export default function notebook(pi: ExtensionAPI): void {
  const rt = createRuntime(pi);

  registerSessionEvents(rt);
  registerPromptEvents(rt);
  registerToolEvents(rt);
  registerTurnEvents(rt);

  registerMemorySave(rt);
  registerMemorySearch(rt);
  registerHandoffUpdate(rt);
  registerMemoryRetire(rt);

  registerShowCommand(rt);
  registerInitCommand(rt);
  registerRememberCommand(rt);
  registerPrefsCommand(rt);
  registerForgetCommand(rt);
  registerPromptCommands(rt);
}
