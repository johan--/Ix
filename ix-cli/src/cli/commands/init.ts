import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";

const CLAUDE_MD = `# Ix Memory System

This project uses Ix Memory for persistent, time-aware context.

## MANDATORY RULES
1. BEFORE answering any question about this codebase → call ix_query
2. AFTER making any design/architecture decision → call ix_decide
3. When noticing contradictory information → call ix_conflicts
4. NEVER guess about codebase facts when Ix has structured data
5. After modifying code → call ix_ingest on changed files
6. At start of each session → review ix://session/context for prior work
7. When the user states a goal → call ix_truth to record it
`;

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize Ix in the current project")
    .action(async () => {
      console.log("Initializing Ix Memory...\n");

      // 1. Check backend health
      const client = new IxClient(getEndpoint());
      try {
        await client.health();
        console.log("  [ok] Backend is running at " + getEndpoint());
      } catch {
        console.error("  [!!] Backend not reachable at " + getEndpoint());
        console.error("       Run ./stack.sh first, or set IX_ENDPOINT.");
        process.exit(1);
      }

      // 2. Create ~/.ix/config.yaml
      const configDir = join(homedir(), ".ix");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "config.yaml"),
        `endpoint: ${getEndpoint()}\nformat: text\n`
      );
      console.log("  [ok] Created ~/.ix/config.yaml");

      // 3. Create CLAUDE.md in project root
      await writeFile("CLAUDE.md", CLAUDE_MD);
      console.log("  [ok] Created CLAUDE.md");

      console.log("\nIx Memory initialized.");
      console.log("Next: run 'ix ingest ./src --recursive' to ingest your codebase.");
    });
}
