import type { Command } from "commander";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain <symbol>")
    .description("Explain an entity")
    .action(async (symbol: string) => {
      const result = await resolveEntity(symbol);
      console.log(result);
    });
}

async function resolveEntity(symbol: string): Promise<string> {
  return `Resolved: ${symbol}`;
}
