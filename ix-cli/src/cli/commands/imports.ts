import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";
import { resolveEntity, printResolved } from "../resolve.js";

export function registerImportsCommand(program: Command): void {
  program
    .command("imports <symbol>")
    .description("Show what the given entity imports")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const target = await resolveEntity(client, symbol, ["file", "module", "class"], opts);
      if (!target) return;
      printResolved(target);
      const result = await client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes, "imports", target.name, opts.format, target, "graph");
    });

  program
    .command("imported-by <symbol>")
    .description("Show what imports the given entity")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const target = await resolveEntity(client, symbol, ["file", "module", "class"], opts);
      if (!target) return;
      printResolved(target);
      const result = await client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] });
      formatEdgeResults(result.nodes, "imported-by", target.name, opts.format, target, "graph");
    });
}
