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
    .option("--summary", "Show compact summary only")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (fromRev: string, toRev: string, opts: { entity?: string; summary?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result: any = await client.diff(parseInt(fromRev, 10), parseInt(toRev, 10), opts.entity);

      if (opts.summary && opts.format !== "json") {
        const changes = result.changes || [];
        const added = changes.filter((c: any) => c.changeType === "added").length;
        const modified = changes.filter((c: any) => c.changeType === "modified").length;
        const removed = changes.filter((c: any) => c.changeType === "removed").length;
        const legacy = changes.filter((c: any) => c.changeType === "added_or_modified").length;
        console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
        if (added) console.log(`  ${chalk.green("Added:")}    ${added}`);
        if (modified) console.log(`  ${chalk.yellow("Modified:")} ${modified}`);
        if (removed) console.log(`  ${chalk.red("Removed:")}  ${removed}`);
        if (legacy) console.log(`  ${chalk.yellow("Changed:")}  ${legacy}`);
        if (!added && !modified && !removed && !legacy) console.log(chalk.dim("  No changes."));
        console.log();
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        formatDiff(result, "text");
      }
    });
}
