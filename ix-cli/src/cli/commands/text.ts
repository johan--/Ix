import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { formatTextResults, type TextResult } from "../format.js";

const execFileAsync = promisify(execFile);

export function registerTextCommand(program: Command): void {
  program
    .command("text <term>")
    .description("Fast lexical/text search across the codebase (uses ripgrep)")
    .option("--limit <n>", "Max results", "20")
    .option("--path <dir>", "Restrict search to a directory", ".")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (term: string, opts: { limit: string; path: string; format: string }) => {
      const limit = parseInt(opts.limit, 10);
      try {
        const { stdout } = await execFileAsync("rg", [
          "--json",
          "--max-count", String(limit),
          "--no-heading",
          term,
          opts.path,
        ], { maxBuffer: 10 * 1024 * 1024 });

        const results: TextResult[] = [];
        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") {
              const data = parsed.data;
              results.push({
                path: data.path?.text ?? "",
                line: data.line_number ?? 0,
                snippet: data.lines?.text ?? "",
              });
            }
          } catch {
            // skip non-JSON lines
          }
        }

        formatTextResults(results.slice(0, limit), opts.format);
      } catch (err: any) {
        if (err.code === "ENOENT") {
          console.error("Error: ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation");
          process.exit(1);
        }
        if (err.code === 1 || err.status === 1) {
          formatTextResults([], opts.format);
        } else {
          throw err;
        }
      }
    });
}
