import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatExplain, type ExplainResult } from "../format.js";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain <symbol>")
    .description("Explain an entity — shows structure, container, and history")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (symbol: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Step 1: Find the entity
      const nodes = await client.search(symbol, { limit: 1 });
      if (nodes.length === 0) {
        console.log(`No entity found matching "${symbol}".`);
        return;
      }
      const node = nodes[0] as any;
      const entityId = node.id;

      // Step 2: Get entity details (claims, edges)
      const details = await client.entity(entityId);

      // Step 3: Get history
      let history: any = { entityId, chain: [] };
      try {
        history = await client.provenance(entityId);
      } catch { /* no history */ }

      // Step 4: Find container (CONTAINS edge pointing to this entity)
      const edges = (details.edges ?? []) as any[];
      const containsEdge = edges.find((e: any) => e.predicate === "CONTAINS" && e.dst === entityId);
      let container: any = undefined;
      if (containsEdge) {
        try {
          const containerDetails = await client.entity(containsEdge.src);
          container = containerDetails.node;
        } catch { /* no container */ }
      }

      // Step 5: Count connections
      const callEdges = edges.filter((e: any) => e.predicate === "CALLS");
      const containedEdges = edges.filter((e: any) => e.predicate === "CONTAINS" && e.src === entityId);

      const result: ExplainResult = {
        kind: node.kind,
        name: node.attrs?.name ?? node.name ?? symbol,
        id: entityId,
        file: node.provenance?.source_uri ?? node.provenance?.sourceUri,
        container: container ? { kind: container.kind, name: container.attrs?.name ?? container.name } : undefined,
        introducedRev: node.createdRev ?? node.created_rev,
        calledBy: callEdges.filter((e: any) => e.dst === entityId).length,
        calls: callEdges.filter((e: any) => e.src === entityId).length,
        contains: containedEdges.length,
        historyLength: (history as any)?.chain?.length ?? 0,
      };

      formatExplain(result, opts.format);
    });
}
