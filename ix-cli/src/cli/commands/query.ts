import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatContext } from "../format.js";

export function registerQueryCommand(program: Command): void {
  program
    .command("query <question>")
    .description("Query the knowledge graph for structured context")
    .option("--as-of <rev>", "Time-travel to a specific revision")
    .option("--depth <depth>", "Query depth (shallow|standard|deep)", "standard")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (question: string, opts: { asOf?: string; depth?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.query(question, {
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
        depth: opts.depth,
      });
      formatContext(result, opts.format);
    });
}
