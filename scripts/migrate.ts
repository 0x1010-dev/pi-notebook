import { parseArgs } from "node:util";
import { planMigration, writeMigration } from "../src/migrate.ts";

try {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      output: { type: "string" },
      scope: { type: "string", default: "project" },
      rules: { type: "string" },
      write: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log("Usage: npm run migrate -- --source <legacy-notebook> [--scope project|global] [--rules <AGENTS.md>] [--output <fresh-staging-dir> --write]\nDefault: dry-run summary only. Originals are never modified.");
  } else {
    if (!values.source) throw new Error("--source is required. Use --help for usage.");
    if (values.scope !== "project" && values.scope !== "global")
      throw new Error("--scope must be project or global.");
    if (values.write && !values.output) throw new Error("--write requires --output.");
    const plan = planMigration({ source: values.source, scope: values.scope, rules: values.rules });
    console.log(JSON.stringify({
      mode: values.write ? "staging" : "dry-run", source: plan.source,
      active: plan.active, historical: plan.historical,
      referenceMap: plan.referenceMap, warnings: plan.warnings,
    }, null, 2));
    if (values.write) {
      writeMigration(plan, values.output!);
      console.log(`Created staging directory: ${values.output}. Review REVIEW.md; no notebook was activated.`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
