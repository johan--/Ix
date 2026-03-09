import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatDiff } from "../format.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <fromRev> <toRev>")
    .description("Show diff between two revisions")
    .option("--entity <id>", "Filter by entity ID")
    .option("--summary", "Show compact summary only (server-side, fast)")
    .option("--limit <n>", "Max changes to return (default 100)")
    .option("--full", "Return all changes (no limit)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (fromRev: string, toRev: string, opts: {
      entity?: string; summary?: boolean; limit?: string; full?: boolean; format: string;
    }) => {
      const client = new IxClient(getEndpoint());
      const from = parseInt(fromRev, 10);
      const to = parseInt(toRev, 10);

      if (opts.summary) {
        const result: any = await client.diff(from, to, { summary: true });

        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const s = result.summary || {};
          console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
          if (s.added) console.log(`  ${chalk.green("Added:")}    ${s.added}`);
          if (s.modified) console.log(`  ${chalk.yellow("Modified:")} ${s.modified}`);
          if (s.removed) console.log(`  ${chalk.red("Removed:")}  ${s.removed}`);
          if (!s.added && !s.modified && !s.removed) console.log(chalk.dim("  No changes."));
          console.log(`  ${chalk.dim("Total:")}    ${result.total}`);
          console.log();
        }
        return;
      }

      const limit = opts.full ? undefined : (opts.limit ? parseInt(opts.limit, 10) : undefined);
      const result: any = await client.diff(from, to, {
        entityId: opts.entity,
        limit,
      });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.truncated) {
          console.log(chalk.yellow(`Showing ${result.changes.length} of ${result.totalChanges} changes. Use --full to see all.\n`));
        }
        formatDiff(result, "text");
      }
    });
}
