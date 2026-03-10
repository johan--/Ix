import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";

export function registerHistoryCommand(program: Command): void {
  program
    .command("history <target>")
    .description("Show provenance chain for a file or entity")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", `\nExamples:
  ix history ix-cli/src/cli/commands/decide.ts
  ix history decide.ts
  ix history IngestionService --kind class
  ix history <entity-uuid>`)
    .action(async (target: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolved = await resolveFileOrEntity(client, target, opts);
      if (!resolved) return;

      if (opts.format !== "json") printResolved(resolved);

      const result = await client.provenance(resolved.id);

      if (opts.format === "json") {
        console.log(JSON.stringify({ resolvedTarget: resolved, provenance: result }, null, 2));
      } else {
        const patches = Array.isArray(result) ? result : (result as any)?.patches ?? [];
        if (patches.length === 0) {
          console.log(chalk.dim("  No provenance records found."));
          return;
        }
        for (const p of patches) {
          const rev = p.rev ?? p.data?.rev ?? "?";
          const timestamp = p.data?.timestamp ?? p.timestamp ?? "";
          const intent = p.data?.intent ?? p.intent ?? "";
          const source = p.data?.source?.uri ?? "";
          console.log(`  ${chalk.cyan(`rev ${rev}`)} ${chalk.dim(timestamp)}`);
          if (intent) console.log(`    ${intent}`);
          if (source) console.log(`    ${chalk.dim(source)}`);
        }
      }
    });
}
