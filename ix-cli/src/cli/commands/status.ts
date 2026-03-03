import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show Ix backend health and status")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      try {
        const health = await client.health();
        if (opts.format === "json") {
          console.log(JSON.stringify(health, null, 2));
        } else {
          console.log(`Ix Memory: ${health.status}`);
          console.log(`Endpoint:  ${getEndpoint()}`);
        }
      } catch (err) {
        console.error(`Ix backend not reachable at ${getEndpoint()}`);
        process.exit(1);
      }
    });
}
