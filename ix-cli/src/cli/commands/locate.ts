import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { formatLocateResults, type LocateResult } from "../format.js";

const execFileAsync = promisify(execFile);

export function registerLocateCommand(program: Command): void {
  program
    .command("locate <symbol>")
    .description("Find a symbol in code and resolve to graph entities")
    .option("--limit <n>", "Max text hits to check", "10")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--root <dir>", "Workspace root directory")
    .action(async (symbol: string, opts: { limit: string; format: string; root?: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);

      // Step 1: Search the graph for matching entities
      const graphNodes = await client.search(symbol, { limit: 5 });

      // Step 2: Run ripgrep for text hits
      let textHits: Array<{ path: string; line: number }> = [];
      try {
        const { stdout } = await execFileAsync("rg", [
          "--json", "--max-count", String(limit),
          "--no-heading", "--word-regexp",
          symbol, resolveWorkspaceRoot(opts.root),
        ], { maxBuffer: 10 * 1024 * 1024 });

        for (const line of stdout.split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "match") {
              textHits.push({
                path: parsed.data.path?.text ?? "",
                line: parsed.data.line_number ?? 0,
              });
            }
          } catch { /* skip */ }
        }
      } catch (err: any) {
        if (err.code !== 1 && err.status !== 1 && err.code !== "ENOENT") throw err;
      }

      // Step 3: Build results — graph entities first, then unmatched text hits
      const results: LocateResult[] = [];
      for (const node of graphNodes) {
        const n = node as any;
        results.push({
          kind: n.kind,
          id: n.id,
          name: n.attrs?.name ?? n.name ?? symbol,
          file: n.provenance?.source_uri ?? n.provenance?.sourceUri,
          source: "graph",
        });
      }

      // Add text-only hits that didn't match any graph entity
      const graphFiles = new Set(results.map(r => r.file).filter(Boolean));
      const seenPaths = new Set<string>();
      for (const hit of textHits) {
        if (!seenPaths.has(hit.path) && !graphFiles.has(hit.path)) {
          seenPaths.add(hit.path);
          results.push({
            kind: "text-match",
            name: symbol,
            file: hit.path,
            line: hit.line,
            source: "ripgrep",
          });
        }
      }

      formatLocateResults(results, opts.format);
    });
}
