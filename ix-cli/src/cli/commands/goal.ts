import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatIntents } from "../format.js";

export function registerGoalCommand(program: Command): void {
  const goal = program
    .command("goal")
    .description("Manage project goals (aliases for ix truth)");

  goal
    .command("create <statement>")
    .description("Create a new goal")
    .option("--parent <id>", "Parent goal ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (statement: string, opts: { parent?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.createTruth(statement, opts.parent);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Goal created: ${result.nodeId} (rev ${result.rev})`);
      }
    });

  goal
    .command("list")
    .description("List all goals")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const intents = await client.listTruth();
      formatIntents(intents, opts.format);
    });
}
