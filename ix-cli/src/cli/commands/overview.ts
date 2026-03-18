import * as nodePath from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveFileOrEntity, printResolved } from "../resolve.js";
import { getSystemPath, hasMapData } from "../hierarchy.js";
import { humanizeLabel } from "../impact/risk-semantics.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "trait", "object", "interface"]);
const REGION_KINDS = new Set(["system", "subsystem", "module", "region"]);
const FILE_KINDS = new Set(["file"]);

const KEY_ITEMS_LIMIT = 5;

interface OverviewResult {
  resolvedTarget: { id: string; kind: string; name: string };
  resolutionMode: string;
  path: string | null;
  systemPath: Array<{ name: string; kind: string }> | null;
  hasMapData: boolean;
  childrenByKind: Record<string, number> | null;
  keyItems: Array<{ name: string; kind: string }> | null;
  diagnostics: string[];
}

export function registerOverviewCommand(program: Command): void {
  program
    .command("overview <target>")
    .description("Structural summary — what a target contains")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--path <path>", "Prefer symbols from files matching this path substring")
    .option("--pick <n>", "Pick Nth candidate from ambiguous results (1-based)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      `\nUse overview for structural summaries. Use 'ix locate' for position.
Use 'ix explain' for role. Use 'ix impact' for risk.

Examples:
  ix overview IngestionService
  ix overview IngestionService --kind class
  ix overview verify_token --kind function --format json
  ix overview src/cli/commands/overview.ts
  ix overview overview.ts
  ix overview scoreCandidate --pick 2`
    )
    .action(async (symbol: string, opts: { kind?: string; path?: string; pick?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const resolveOpts = { kind: opts.kind, path: opts.path, pick: opts.pick ? parseInt(opts.pick, 10) : undefined };
      const target = await resolveFileOrEntity(client, symbol, resolveOpts);
      if (!target) return;

      if (opts.format !== "json") printResolved(target);

      const isContainer = CONTAINER_KINDS.has(target.kind);
      const isRegion = REGION_KINDS.has(target.kind);

      if (isContainer || isRegion) {
        await overviewContainer(client, target, opts.format);
      } else {
        await overviewLeaf(client, target, opts.format);
      }
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toRepoRelative(filePath: string): string {
  if (!nodePath.isAbsolute(filePath)) return filePath;
  try {
    const cwd = process.cwd();
    const rel = nodePath.relative(cwd, filePath);
    if (!rel.startsWith("..") && !nodePath.isAbsolute(rel)) return rel;
  } catch {}
  return filePath;
}

function humanizeBreadcrumb(nodes: Array<{ name: string; kind: string }>): string {
  return nodes.map((n) => {
    if (REGION_KINDS.has(n.kind)) return humanizeLabel(n.name).replace(/ layer$/, "");
    return n.name;
  }).join(" → ");
}

/** Label for the "Key ..." section based on target kind. */
function keyItemsLabel(kind: string): string {
  if (FILE_KINDS.has(kind)) return "Key definitions";
  if (REGION_KINDS.has(kind)) return "Key files";
  return "Key members";
}

/** Humanize a kind for the Contains section (e.g. "method" → "Methods"). */
function kindLabel(kind: string): string {
  const labels: Record<string, string> = {
    method: "Methods",
    function: "Functions",
    field: "Fields",
    class: "Classes",
    interface: "Interfaces",
    trait: "Traits",
    object: "Objects",
    file: "Files",
    enum: "Enums",
    type: "Types",
    type_alias: "Type aliases",
    module: "Modules",
    region: "Regions",
    subsystem: "Subsystems",
    constructor: "Constructors",
    def: "Methods",
    fun: "Functions",
    val: "Fields",
    var: "Fields",
  };
  const label = labels[kind.toLowerCase()];
  if (label) return label;
  // Fallback: capitalize
  return kind.charAt(0).toUpperCase() + kind.slice(1) + "s";
}

// ── Container / Region overview ─────────────────────────────────────────────

async function overviewContainer(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];
  const isRegion = REGION_KINDS.has(target.kind);

  // For regions, children come via IN_REGION; for code containers, via CONTAINS
  const childPredicate = isRegion ? "IN_REGION" : "CONTAINS";

  const [details, childrenResult, systemPath] = await Promise.all([
    client.entity(target.id),
    client.expand(target.id, { direction: "out", predicates: [childPredicate] }),
    getSystemPath(client, target.id),
  ]);

  const node = details.node as any;
  const rawPath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;
  const displayPath = rawPath ? toRepoRelative(rawPath) : null;

  const children = childrenResult.nodes;

  // Group children by kind → count
  const childrenByKind: Record<string, number> = {};
  const childList: Array<{ name: string; kind: string }> = [];
  for (const m of children) {
    const member = m as any;
    const kind = member.kind || "unknown";
    const name = member.name || member.attrs?.name || "(unnamed)";
    childrenByKind[kind] = (childrenByKind[kind] || 0) + 1;
    childList.push({ name, kind });
  }

  // Key items: first N unique children
  const keyItems = childList.slice(0, KEY_ITEMS_LIMIT);

  const hasMap = hasMapData(systemPath);
  if (!hasMap) {
    diagnostics.push("No system map. Run `ix map` to see hierarchy.");
  }

  const systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    path: displayPath,
    systemPath: systemPathMapped,
    hasMapData: hasMap,
    childrenByKind: Object.keys(childrenByKind).length > 0 ? childrenByKind : null,
    keyItems: keyItems.length > 0 ? keyItems : null,
    diagnostics,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Text rendering
  renderOverviewHeader(target, displayPath, systemPathMapped, hasMap);

  // Contains
  if (Object.keys(childrenByKind).length > 0) {
    console.log(chalk.bold("\nContains"));
    // Sort by count descending
    const sorted = Object.entries(childrenByKind).sort((a, b) => b[1] - a[1]);
    for (const [kind, count] of sorted) {
      console.log(`  ${chalk.dim(kindLabel(kind).padEnd(16))}${count}`);
    }
  }

  // Key items
  if (keyItems.length > 0) {
    console.log(chalk.bold(`\n${keyItemsLabel(target.kind)}`));
    for (const item of keyItems) {
      console.log(`  ${item.name}`);
    }
  }

  renderDiagnostics(diagnostics);
}

// ── Leaf (function/method) overview ─────────────────────────────────────────

async function overviewLeaf(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  format: string
): Promise<void> {
  const diagnostics: string[] = [];

  const [details, systemPath] = await Promise.all([
    client.entity(target.id),
    getSystemPath(client, target.id),
  ]);

  const node = details.node as any;
  const rawPath = node.provenance?.source_uri ?? node.provenance?.sourceUri ?? null;
  const displayPath = rawPath ? toRepoRelative(rawPath) : null;

  const hasMap = hasMapData(systemPath);
  if (!hasMap) {
    diagnostics.push("No system map. Run `ix map` to see hierarchy.");
  }

  // Append target to system path if not already there
  let systemPathMapped = systemPath.map((n) => ({ name: n.name, kind: n.kind }));
  const lastInPath = systemPathMapped[systemPathMapped.length - 1];
  if (!lastInPath || lastInPath.name !== target.name) {
    systemPathMapped = [...systemPathMapped, { name: target.name, kind: target.kind }];
  }

  const result: OverviewResult = {
    resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
    resolutionMode: target.resolutionMode,
    path: displayPath,
    systemPath: systemPathMapped,
    hasMapData: hasMap,
    childrenByKind: null,
    keyItems: null,
    diagnostics,
  };

  if (format === "json") {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  renderOverviewHeader(target, displayPath, systemPathMapped, hasMap);
  renderDiagnostics(diagnostics);
}

// ── Shared rendering ────────────────────────────────────────────────────────

function renderOverviewHeader(
  target: { kind: string; name: string },
  displayPath: string | null,
  systemPath: Array<{ name: string; kind: string }>,
  hasMap: boolean,
): void {
  console.log(chalk.bold("\nOverview"));
  console.log(`  ${chalk.dim("Kind:".padEnd(14))}${target.kind}`);
  if (displayPath) {
    console.log(`  ${chalk.dim("File:".padEnd(14))}${displayPath}`);
  }
  if (systemPath.length > 1 && hasMap) {
    console.log(`  ${chalk.dim("System path:".padEnd(14))}${humanizeBreadcrumb(systemPath)}`);
  }
}

function renderDiagnostics(diagnostics: string[]): void {
  for (const d of diagnostics) {
    console.log(chalk.dim(`\n  ${d}`));
  }
}
