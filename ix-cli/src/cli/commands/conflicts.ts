import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerConflictsCommand(program: Command): void {
  program
    .command("conflicts")
    .description("List detected conflicts")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const conflicts = await client.conflicts();
      if (opts.format === "json") {
        console.log(JSON.stringify(conflicts, null, 2));
      } else {
        if ((conflicts as unknown[]).length === 0) {
          console.log("No conflicts detected.");
        } else {
          console.log(JSON.stringify(conflicts, null, 2));
        }
      }
    });
}
