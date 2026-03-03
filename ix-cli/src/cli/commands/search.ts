import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes } from "../format.js";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <term>")
    .description("Search the knowledge graph by term")
    .option("--limit <n>", "Max results", "20")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (term: string, opts: { limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const nodes = await client.search(term, parseInt(opts.limit, 10));
      formatNodes(nodes, opts.format);
    });
}
