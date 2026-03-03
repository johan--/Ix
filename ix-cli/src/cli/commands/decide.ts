import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerDecideCommand(program: Command): void {
  program
    .command("decide <title>")
    .description("Record a design decision")
    .requiredOption("--rationale <text>", "Rationale for the decision")
    .option("--intent-id <id>", "Link to an intent")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { rationale: string; intentId?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.decide(title, opts.rationale, { intentId: opts.intentId });
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Decision recorded: ${result.nodeId} (rev ${result.rev})`);
      }
    });
}
