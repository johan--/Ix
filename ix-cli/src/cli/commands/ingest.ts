import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest <path>")
    .description("Ingest source files into the knowledge graph")
    .option("--recursive", "Recursively ingest directory")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (path: string, opts: { recursive?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());
      const result = await client.ingest(path, opts.recursive);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Ingested: ${(result as any).filesProcessed ?? 0} files, ${(result as any).patchesApplied ?? 0} patches (rev ${(result as any).latestRev ?? 0})`);
      }
    });
}
