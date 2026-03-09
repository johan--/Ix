import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatNodes } from "../format.js";

export function registerPlansCommand(program: Command): void {
  program
    .command("plans")
    .description("List all plans")
    .option("--limit <n>", "Max results", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const nodes = await client.listByKind("plan", { limit: parseInt(opts.limit, 10) });
      formatNodes(nodes, opts.format);
    });
}
