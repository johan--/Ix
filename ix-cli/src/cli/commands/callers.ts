import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatEdgeResults } from "../format.js";
import { resolveEntity, printResolved } from "../resolve.js";

export function registerCallersCommand(program: Command): void {
  program
    .command("callers <symbol>")
    .description("Show methods/functions that call the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const target = await resolveEntity(client, symbol, ["method", "function"], opts);
      if (!target) return;
      printResolved(target);
      // Use expandByName for cross-file resolution
      const result = await client.expandByName(target.name, {
        direction: "in",
        predicates: ["CALLS"],
        kinds: ["function", "method"],
      });
      formatEdgeResults(result.nodes, "callers", target.name, opts.format, target, "graph");
    });

  program
    .command("callees <symbol>")
    .description("Show methods/functions called by the given symbol (cross-file)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { kind?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const target = await resolveEntity(client, symbol, ["method", "function"], opts);
      if (!target) return;
      printResolved(target);
      // Use expandByName for cross-file resolution
      const result = await client.expandByName(target.name, {
        direction: "out",
        predicates: ["CALLS"],
        kinds: ["function", "method"],
      });
      formatEdgeResults(result.nodes, "callees", target.name, opts.format, target, "graph");
    });
}
