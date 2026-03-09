import chalk from "chalk";
import type { IxClient } from "../client/api.js";
import { stderr } from "./stderr.js";

export type ResolutionMode = "exact" | "preferred-kind" | "ambiguous" | "heuristic";

export interface ResolvedEntity {
  id: string;
  kind: string;
  name: string;
  resolutionMode: ResolutionMode;
}

/**
 * Resolve a symbol to a single entity, preferring specific kinds.
 * Returns null and prints guidance if no match or ambiguous.
 */
export async function resolveEntity(
  client: IxClient,
  symbol: string,
  preferredKinds: string[],
  opts?: { kind?: string }
): Promise<ResolvedEntity | null> {
  const kindFilter = opts?.kind;
  const nodes = await client.search(symbol, { limit: 20, kind: kindFilter });

  if (nodes.length === 0) {
    stderr(`No entity found matching "${symbol}".`);
    return null;
  }

  // Exact name matches only
  const exact = nodes.filter((n: any) => {
    const name = n.name || n.attrs?.name || "";
    return name.toLowerCase() === symbol.toLowerCase();
  });

  const candidates = exact.length > 0 ? exact : nodes;

  // If user specified --kind, take the first match
  if (kindFilter) {
    const node = candidates[0] as any;
    return { id: node.id, kind: node.kind, name: node.name || node.attrs?.name || symbol, resolutionMode: "exact" };
  }

  // Try preferred kinds in order
  for (const pk of preferredKinds) {
    const match = candidates.find((n: any) => n.kind === pk);
    if (match) {
      return { id: (match as any).id, kind: (match as any).kind, name: (match as any).name || (match as any).attrs?.name || symbol, resolutionMode: "preferred-kind" };
    }
  }

  // If only one candidate, use it
  if (candidates.length === 1) {
    const node = candidates[0] as any;
    return { id: node.id, kind: node.kind, name: node.name || node.attrs?.name || symbol, resolutionMode: "exact" };
  }

  // Multiple candidates, no preferred kind match — show ambiguity
  stderr(`Multiple matches for "${symbol}":`);
  const seen = new Set<string>();
  for (const n of candidates.slice(0, 5)) {
    const node = n as any;
    const key = `${node.kind}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const shortId = node.id.slice(0, 8);
    const name = node.name || node.attrs?.name || "(unnamed)";
    stderr(`  ${chalk.cyan((node.kind ?? "").padEnd(10))} ${chalk.dim(shortId)}  ${name}`);
  }
  stderr(chalk.dim(`\nUse --kind <kind> to disambiguate.`));
  return null;
}

/**
 * Print the resolved target before showing results (text mode only).
 * Callers should skip this when format === "json" to keep JSON strict.
 */
export function printResolved(target: ResolvedEntity): void {
  const shortId = target.id.slice(0, 8);
  const modeStr = target.resolutionMode !== "exact"
    ? chalk.dim(` (${target.resolutionMode})`)
    : "";
  stderr(`${chalk.dim("Resolved:")} ${chalk.cyan(target.kind)} ${chalk.dim(shortId)} ${chalk.bold(target.name)}${modeStr}\n`);
}

/** Check if a string looks like a raw UUID (not a human-readable name). */
export function isRawId(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(s)
    || /^[0-9a-f]{32,}$/i.test(s);
}
