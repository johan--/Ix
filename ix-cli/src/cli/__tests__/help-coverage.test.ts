import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify that HELP_HEADER in main.ts mentions all core commands.
 * This prevents regression where new commands become invisible.
 */

const mainTsPath = path.resolve(__dirname, "../main.ts");
const mainTsContent = fs.readFileSync(mainTsPath, "utf-8");

// Extract the HELP_HEADER string from main.ts
const headerMatch = mainTsContent.match(/const HELP_HEADER = `([\s\S]*?)`;/);
const HELP_HEADER = headerMatch?.[1] ?? "";

const REQUIRED_COMMANDS = [
  "read", "search", "locate", "contains", "callers", "callees",
  "imports", "entity", "status", "stats", "doctor", "history", "diff",
  "briefing", "overview", "impact", "rank", "inventory",
  "plan", "task", "tasks", "workflow", "bug", "bugs", "decide", "goal", "goals",
  "ingest", "truth", "text", "explain",
];

describe("help coverage", () => {
  it("HELP_HEADER is non-empty", () => {
    expect(HELP_HEADER.length).toBeGreaterThan(100);
  });

  it("HELP_HEADER mentions all core commands", () => {
    const missing: string[] = [];
    for (const cmd of REQUIRED_COMMANDS) {
      // Match command name at start of a line (with leading whitespace)
      if (!HELP_HEADER.includes(cmd)) {
        missing.push(cmd);
      }
    }
    expect(missing).toEqual([]);
  });
});
