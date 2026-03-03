import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatPatches } from "../format.js";

export function registerPatchesCommand(program: Command): void {
  program
    .command("patches")
    .description("List recent patches")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const patches = await client.listPatches();
      formatPatches(patches, opts.format);
    });
}
