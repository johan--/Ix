import * as fs from "node:fs";
import * as path from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity } from "../resolve.js";
import { formatDiff } from "../format.js";
import { stderr } from "../stderr.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <fromRev> <toRev> [target]")
    .description("Show diff between two revisions, optionally scoped to a file or entity")
    .option("--entity <id>", "Filter by entity ID (deprecated, use positional target)")
    .option("--summary", "Show compact summary only (server-side, fast)")
    .option("--content", "Show detailed attribute changes for each entity")
    .option("--limit <n>", "Max changes to return (default 100)")
    .option("--full", "Return all changes (no limit)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText("after", `\nExamples:
  ix diff 3 5
  ix diff 3 5 ix-cli/src/cli/commands/decide.ts
  ix diff 3 5 decide.ts --content
  ix diff 3 5 buildDecisionPatch
  ix diff 3 5 --summary`)
    .action(async (fromRev: string, toRev: string, target: string | undefined, opts: {
      entity?: string; summary?: boolean; content?: boolean; limit?: string; full?: boolean; format: string;
    }) => {
      const client = new IxClient(getEndpoint());
      const from = parseInt(fromRev, 10);
      const to = parseInt(toRev, 10);

      // Resolve the scope entity from positional target or --entity flag
      let entityId: string | undefined = opts.entity;
      if (target && !entityId) {
        const resolved = await resolveFileOrEntity(client, target);
        if (!resolved) return;
        entityId = resolved.id;
        if (opts.format !== "json") {
          stderr(`${chalk.dim("Scoped to:")} ${chalk.cyan(resolved.kind)} ${chalk.bold(resolved.name)}\n`);
        }
      }

      if (opts.summary) {
        const result: any = await client.diff(from, to, { summary: true, entityId });

        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const s = result.summary || {};
          console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
          if (s.added) console.log(`  ${chalk.green("Added:")}    ${s.added}`);
          if (s.modified) console.log(`  ${chalk.yellow("Modified:")} ${s.modified}`);
          if (s.removed) console.log(`  ${chalk.red("Removed:")}  ${s.removed}`);
          if (!s.added && !s.modified && !s.removed) console.log(chalk.dim("  No changes."));
          console.log(`  ${chalk.dim("Total:")}    ${result.total}`);
          console.log();
        }
        return;
      }

      const limit = opts.full ? undefined : (opts.limit ? parseInt(opts.limit, 10) : undefined);
      const result: any = await client.diff(from, to, { entityId, limit });

      if (opts.format === "json") {
        if (opts.content) {
          // Augment each change with source content when available
          const changes = (result as any).changes ?? [];
          for (const c of changes) {
            const node = c.atToRev ?? c.atFromRev;
            const source = readSourceSpan(node);
            if (source) c.sourceContent = source;
          }
        }
        console.log(JSON.stringify(result, null, 2));
      } else if (opts.content) {
        formatDiffContent(result);
      } else {
        if (result.truncated) {
          console.log(chalk.yellow(`Showing ${result.changes.length} of ${result.totalChanges} changes. Use --full to see all.\n`));
        }
        formatDiff(result, "text");
      }
    });
}

/** Try to read source lines from disk using entity provenance and line spans. */
function readSourceSpan(node: any): string | null {
  if (!node) return null;
  const uri: string = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? "";
  if (!uri) return null;

  const attrs = node.attrs ?? {};
  const lineStart = attrs.line_start ?? attrs.lineStart;
  const lineEnd = attrs.line_end ?? attrs.lineEnd;
  if (lineStart == null || lineEnd == null) return null;

  // Resolve path relative to cwd
  const filePath = path.resolve(uri);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, Number(lineStart) - 1);
    const end = Math.min(lines.length, Number(lineEnd));
    if (start >= end) return null;
    return lines.slice(start, end).join("\n");
  } catch {
    return null;
  }
}

/** Render detailed attribute-level changes with source code for each entity. */
function formatDiffContent(result: any): void {
  console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
  const changes = result.changes ?? [];
  if (changes.length === 0) {
    console.log(chalk.dim("  No changes in this range."));
    return;
  }

  for (const c of changes) {
    const before = c.atFromRev;
    const after = c.atToRev;
    const name = after?.name ?? before?.name ?? c.entityId?.substring(0, 8) ?? "?";
    const kind = after?.kind ?? before?.kind ?? "unknown";
    const typeChar = c.changeType === "added" ? "+" : c.changeType === "removed" ? "-" : "~";
    const typeColor = c.changeType === "added" ? chalk.green : c.changeType === "removed" ? chalk.red : chalk.yellow;

    console.log(`\n${typeColor(typeChar)} ${chalk.cyan(kind)} ${chalk.bold(name)}`);

    const activeNode = after ?? before;
    const uri = activeNode?.provenance?.source_uri ?? activeNode?.provenance?.sourceUri ?? "";
    if (uri) console.log(`  ${chalk.dim("file:")} ${uri}`);

    if (c.changeType === "added" && after) {
      printAttrs("  ", after.attrs);
    } else if (c.changeType === "modified" && before && after) {
      diffAttrs("  ", before.attrs ?? {}, after.attrs ?? {});
    }

    // Show source code from disk when available
    const source = readSourceSpan(activeNode);
    if (source) {
      const lineStart = (activeNode.attrs?.line_start ?? activeNode.attrs?.lineStart) || "?";
      console.log(`  ${chalk.dim(`source (L${lineStart}):`)} `);
      for (const line of source.split("\n")) {
        console.log(`  ${chalk.dim("│")} ${line}`);
      }
    }
  }
  console.log();
}

function printAttrs(indent: string, attrs: Record<string, unknown> | undefined): void {
  if (!attrs) return;
  for (const [key, val] of Object.entries(attrs)) {
    if (val === null || val === undefined) continue;
    const display = typeof val === "string" ? val : JSON.stringify(val);
    console.log(`${indent}${chalk.dim(key + ":")} ${display}`);
  }
}

function diffAttrs(indent: string, before: Record<string, unknown>, after: Record<string, unknown>): void {
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    const bVal = before[key];
    const aVal = after[key];
    if (bVal === undefined && aVal !== undefined) {
      const display = typeof aVal === "string" ? aVal : JSON.stringify(aVal);
      console.log(`${indent}${chalk.green("+")} ${chalk.dim(key + ":")} ${display}`);
    } else if (bVal !== undefined && aVal === undefined) {
      const display = typeof bVal === "string" ? bVal : JSON.stringify(bVal);
      console.log(`${indent}${chalk.red("-")} ${chalk.dim(key + ":")} ${display}`);
    } else if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      const bDisplay = typeof bVal === "string" ? bVal : JSON.stringify(bVal);
      const aDisplay = typeof aVal === "string" ? aVal : JSON.stringify(aVal);
      console.log(`${indent}${chalk.yellow("~")} ${chalk.dim(key + ":")} ${chalk.red(String(bDisplay))} → ${chalk.green(String(aDisplay))}`);
    }
  }
}
