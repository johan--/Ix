import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity } from "../resolve.js";
import { deterministicId } from "../github/transform.js";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";

interface DecisionLinkOpts {
  affects?: { id: string; kind: string; name: string }[];
  supersedes?: string;
  parent?: string;
  respondsTo?: string;
}
// Test comment
export function buildDecisionPatch(
  title: string,
  rationale: string,
  linkOpts: DecisionLinkOpts = {}
): GraphPatchPayload {
  const now = new Date().toISOString();
  const decisionId = deterministicId(`decision:${title}:${now}`);
  const ops: PatchOp[] = [];

  // 1. UpsertNode for the decision
  ops.push({
    type: "UpsertNode",
    id: decisionId,
    kind: "decision",
    name: title,
    attrs: { rationale, created_at: now },
  });

  // 2. DECISION_AFFECTS edges
  if (linkOpts.affects) {
    for (const entity of linkOpts.affects) {
      ops.push({
        type: "UpsertEdge",
        id: deterministicId(`${decisionId}:DECISION_AFFECTS:${entity.id}`),
        src: decisionId,
        dst: entity.id,
        predicate: "DECISION_AFFECTS",
        attrs: {},
      });
    }
  }

  // 3. DECISION_SUPERSEDES edge
  if (linkOpts.supersedes) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${decisionId}:DECISION_SUPERSEDES:${linkOpts.supersedes}`),
      src: decisionId,
      dst: linkOpts.supersedes,
      predicate: "DECISION_SUPERSEDES",
      attrs: {},
    });
  }

  // 4. DECISION_CHILD edge (parent → child)
  if (linkOpts.parent) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${linkOpts.parent}:DECISION_CHILD:${decisionId}`),
      src: linkOpts.parent,
      dst: decisionId,
      predicate: "DECISION_CHILD",
      attrs: {},
    });
  }

  // 5. DECISION_RESPONDS_TO_BUG edge
  if (linkOpts.respondsTo) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${decisionId}:DECISION_RESPONDS_TO_BUG:${linkOpts.respondsTo}`),
      src: decisionId,
      dst: linkOpts.respondsTo,
      predicate: "DECISION_RESPONDS_TO_BUG",
      attrs: {},
    });
  }

  return {
    patchId: decisionId,
    actor: "ix-cli",
    timestamp: now,
    source: {
      uri: `ix://decision/${encodeURIComponent(title)}`,
      extractor: "ix-cli:decide",
      sourceType: "decision",
    },
    baseRev: 0,
    ops,
    replaces: [],
  };
}

export function registerDecideCommand(program: Command): void {
  program
    .command("decide <title>")
    .description("Record a design decision")
    .requiredOption("--rationale <text>", "Rationale for the decision")
    .option("--intent-id <id>", "Link to an intent")
    .option("--affects <entities>", "Comma-separated entity names to link (creates DECISION_AFFECTS edges)")
    .option("--supersedes <id>", "Decision ID this supersedes")
    .option("--parent <id>", "Parent decision ID")
    .option("--responds-to <bugId>", "Bug ID this decision responds to (creates DECISION_RESPONDS_TO_BUG edge)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(
      async (
        title: string,
        opts: {
          rationale: string;
          intentId?: string;
          affects?: string;
          supersedes?: string;
          parent?: string;
          respondsTo?: string;
          format: string;
        }
      ) => {
        const client = new IxClient(getEndpoint());
        const hasLinks = opts.affects || opts.supersedes || opts.parent || opts.respondsTo;

        if (hasLinks) {
          // Use GraphPatch path for linked decisions
          let resolvedAffects: { id: string; kind: string; name: string }[] | undefined;

          if (opts.affects) {
            const specs = opts.affects.split(",").map((s) => s.trim());
            resolvedAffects = [];
            for (const spec of specs) {
              const atIdx = spec.lastIndexOf("@");
              const name = atIdx >= 0 ? spec.slice(0, atIdx) : spec;
              const path = atIdx >= 0 ? spec.slice(atIdx + 1) : undefined;
              const resolved = await resolveEntity(client, name, [
                "function", "method", "class", "module", "file", "trait", "object", "interface",
              ], { path });
              if (resolved) {
                resolvedAffects.push({ id: resolved.id, kind: resolved.kind, name: resolved.name });
              }
            }
          }

          const patch = buildDecisionPatch(title, opts.rationale, {
            affects: resolvedAffects,
            supersedes: opts.supersedes,
            parent: opts.parent,
            respondsTo: opts.respondsTo,
          });

          if (opts.intentId) {
            patch.intent = opts.intentId;
          }

          const result = await client.commitPatch(patch);
          if (opts.format === "json") {
            console.log(JSON.stringify({ ...result, decisionId: patch.ops[0].id }, null, 2));
          } else {
            console.log(`Decision recorded: ${patch.ops[0].id} (rev ${result.rev})`);
            if (resolvedAffects?.length) {
              console.log(`  Linked to: ${resolvedAffects.map((e) => e.name).join(", ")}`);
            }
          }
        } else {
          // Use the original backend endpoint for simple decisions
          const result = await client.decide(title, opts.rationale, { intentId: opts.intentId });
          if (opts.format === "json") {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`Decision recorded: ${result.nodeId} (rev ${result.rev})`);
          }
        }
      }
    );
}
