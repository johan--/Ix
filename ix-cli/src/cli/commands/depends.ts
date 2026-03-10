import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved, isRawId } from "../resolve.js";

export function registerDependsCommand(program: Command): void {
  program
    .command("depends <symbol>")
    .description("Show what depends on the given entity (reverse CALLS + IMPORTS)")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--depth <n>", "Traversal depth (default 1)", "1")
    .option("--limit <n>", "Max results to show", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", "\nExamples:\n  ix depends verify_token\n  ix depends AuthProvider --depth 2 --format json\n  ix depends parser.py --kind file --limit 20")
    .action(async (symbol: string, opts: { kind?: string; pick?: string; depth: string; limit: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const resolveOpts = { kind: opts.kind, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;

      const hops = parseInt(opts.depth, 10) || 1;

      const [callResult, importResult] = await Promise.all([
        client.expand(target.id, { direction: "in", predicates: ["CALLS"], hops }),
        client.expand(target.id, { direction: "in", predicates: ["IMPORTS"], hops }),
      ]);

      const seen = new Set<string>();
      const callers: any[] = [];
      const importers: any[] = [];

      for (const n of callResult.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          callers.push({ ...n, via: "CALLS" });
        }
      }
      for (const n of importResult.nodes) {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          importers.push({ ...n, via: "IMPORTS" });
        }
      }

      const allDependents = [...callers, ...importers].slice(0, limit);

      const mapDependent = (d: any) => {
        const name = d.name || d.attrs?.name || "";
        const resolved = !!name && !isRawId(name);
        return {
          name: resolved ? name : undefined,
          kind: d.kind,
          id: resolved ? d.id : undefined,
          resolved,
          via: d.via,
          path: d.provenance?.source_uri ?? d.provenance?.sourceUri ?? d.attrs?.path ?? undefined,
          ...(resolved ? { suggestedCommand: `ix explain "${name}"` } : { rawId: d.id }),
        };
      };

      if (opts.format === "json") {
        const results = allDependents.map(mapDependent);
        const unresolvedCount = results.filter(r => !r.resolved).length;
        const output: any = {
          resolvedTarget: target,
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          results,
          summary: {
            total: allDependents.length,
            resolved: allDependents.length - unresolvedCount,
            unresolved: unresolvedCount,
            viaCalls: callers.length,
            viaImports: importers.length,
          },
        };
        if (allDependents.length === 0) {
          output.diagnostics = [{ code: "no_edges", message: `No CALLS or IMPORTS edges found pointing to resolved entity.` }];
        } else if (unresolvedCount > 0) {
          output.diagnostics = [{ code: "dangling_reference_filtered", message: `${unresolvedCount} dependent(s) could not be resolved to named entities.` }];
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }

      printResolved(target);
      if (allDependents.length === 0) {
        console.log(`Resolved to ${target.kind} ${target.name}; no CALLS/IMPORTS edges found at current graph state.`);
        return;
      }

      if (callers.length > 0) {
        console.log(chalk.bold(`  via CALLS (${callers.length}):`));
        for (const d of callers) {
          const shortId = d.id?.slice(0, 8) ?? "";
          const name = d.name || d.attrs?.name || "";
          if (!name || isRawId(name)) {
            console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${chalk.dim("(unresolved)")}`);
          } else {
            console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
          }
        }
      }

      if (importers.length > 0) {
        console.log(chalk.bold(`  via IMPORTS (${importers.length}):`));
        for (const d of importers) {
          const shortId = d.id?.slice(0, 8) ?? "";
          const name = d.name || d.attrs?.name || "";
          if (!name || isRawId(name)) {
            console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${chalk.dim("(unresolved)")}`);
          } else {
            console.log(`    ${chalk.cyan((d.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
          }
        }
      }

      console.log(chalk.dim(`\n  Total: ${allDependents.length} direct dependents`));
    });
}
