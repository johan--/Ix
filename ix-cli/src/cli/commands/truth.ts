import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes } from "../format.js";

export function registerTruthCommand(program: Command): void {
  const truth = program
    .command("truth")
    .description("Manage project intents (truth)");

  truth
    .command("list")
    .description("List all intents")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const intents = await client.listTruth();
      formatNodes(intents, opts.format);
    });

  truth
    .command("add <statement>")
    .description("Add a new intent")
    .option("--parent <id>", "Parent intent ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (statement: string, opts: { parent?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.createTruth(statement, opts.parent);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Intent created: ${result.nodeId} (rev ${result.rev})`);
      }
    });
}
