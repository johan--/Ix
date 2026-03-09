import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatBugs } from "../format.js";

export function registerBugsCommand(program: Command): void {
  program
    .command("bugs")
    .description("List all bugs")
    .option("--status <status>", "Filter by status (open|investigating|resolved|closed)")
    .option("--limit <n>", "Max results", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { status?: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      let nodes = await client.listByKind("bug", { limit: parseInt(opts.limit, 10) });

      if (opts.status) {
        nodes = nodes.filter((n: any) => {
          const status = n.attrs?.status ?? "open";
          return status === opts.status;
        });
      }

      formatBugs(nodes, opts.format);
    });
}
