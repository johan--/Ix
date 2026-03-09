import type { Command } from "commander";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { deterministicId } from "../github/transform.js";
import { resolveEntity } from "../resolve.js";
import { stderr } from "../stderr.js";
import chalk from "chalk";

// ── Patch builders (exported for testing) ──────────────────────────

function makeBugPatchEnvelope(ops: PatchOp[], intent?: string): GraphPatchPayload {
  return {
    patchId: deterministicId(`bug-patch-${Date.now()}-${Math.random()}`),
    actor: "ix-cli",
    timestamp: new Date().toISOString(),
    source: {
      uri: "ix-cli://bug",
      extractor: "ix-cli-bug",
      sourceType: "cli",
    },
    baseRev: 0,
    ops,
    replaces: [],
    intent,
  };
}

interface BugLinkOpts {
  affects?: { id: string; kind: string; name: string }[];
}

export function buildBugPatch(
  title: string,
  description: string,
  severity: string = "medium",
  linkOpts: BugLinkOpts = {}
): GraphPatchPayload {
  const now = new Date().toISOString();
  const bugId = deterministicId(`bug:${title}:${now}`);
  const ops: PatchOp[] = [];

  ops.push({
    type: "UpsertNode",
    id: bugId,
    kind: "bug",
    name: title,
    attrs: { description, status: "open", severity, created_at: now },
  });

  if (linkOpts.affects) {
    for (const entity of linkOpts.affects) {
      ops.push({
        type: "UpsertEdge",
        id: deterministicId(`${bugId}:BUG_AFFECTS:${entity.id}`),
        src: bugId,
        dst: entity.id,
        predicate: "BUG_AFFECTS",
        attrs: {},
      });
    }
  }

  return makeBugPatchEnvelope(ops, `Create bug: ${title}`);
}

export function buildBugUpdatePatch(bugId: string, status: string): GraphPatchPayload {
  const ops: PatchOp[] = [
    {
      type: "AssertClaim",
      entityId: bugId,
      field: "status",
      value: status,
      confidence: 1.0,
    },
  ];
  return makeBugPatchEnvelope(ops, `Update bug ${bugId} status to ${status}`);
}

// ── CLI commands ───────────────────────────────────────────────────

const VALID_STATUSES = ["open", "investigating", "resolved", "closed"];
const VALID_SEVERITIES = ["low", "medium", "high", "critical"];

const STATUS_ICONS: Record<string, string> = {
  open: "○",
  investigating: "◐",
  resolved: "●",
  closed: "✓",
};

export function registerBugCommand(program: Command): void {
  const bug = program
    .command("bug")
    .description("Manage bugs");

  bug
    .command("create <title>")
    .description("Create a new bug")
    .option("--description <text>", "Bug description", "")
    .option("--affects <entities>", "Comma-separated entity names to link (creates BUG_AFFECTS edges)")
    .option("--severity <level>", `Severity (${VALID_SEVERITIES.join("|")})`, "medium")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { description: string; affects?: string; severity: string; format: string }) => {
      if (!VALID_SEVERITIES.includes(opts.severity)) {
        stderr(`Invalid severity "${opts.severity}". Valid: ${VALID_SEVERITIES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const client = new IxClient(getEndpoint());
      let resolvedAffects: { id: string; kind: string; name: string }[] | undefined;

      if (opts.affects) {
        const names = opts.affects.split(",").map(s => s.trim());
        resolvedAffects = [];
        for (const name of names) {
          const resolved = await resolveEntity(client, name, [
            "class", "module", "file", "function", "method", "trait", "object", "interface",
          ]);
          if (resolved) {
            resolvedAffects.push({ id: resolved.id, kind: resolved.kind, name: resolved.name });
          }
        }
      }

      const patch = buildBugPatch(title, opts.description, opts.severity, {
        affects: resolvedAffects,
      });
      const result = await client.commitPatch(patch);
      const bugId = patch.ops[0].id as string;

      if (opts.format === "json") {
        console.log(JSON.stringify({ bugId, rev: result.rev, status: result.status }, null, 2));
      } else {
        console.log(`Bug created: ${bugId} (rev ${result.rev})`);
        if (resolvedAffects?.length) {
          console.log(`  Linked to: ${resolvedAffects.map(e => e.name).join(", ")}`);
        }
      }
    });

  bug
    .command("show <bugId>")
    .description("Show bug details")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (bugId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const details = await client.entity(bugId);
      const node = details.node as any;

      // Expand BUG_AFFECTS and RESPONDS_TO edges
      const [affectsResult, respondsToResult] = await Promise.all([
        client.expand(bugId, { direction: "out", predicates: ["BUG_AFFECTS"] }),
        client.expand(bugId, { direction: "in", predicates: ["RESPONDS_TO"] }),
      ]);

      const affects = affectsResult.nodes.map((n: any) => ({
        id: n.id,
        kind: n.kind,
        name: n.name || n.attrs?.name || "(unnamed)",
      }));

      const plans = respondsToResult.nodes.map((n: any) => ({
        id: n.id,
        name: n.name || n.attrs?.name || "(unnamed)",
      }));

      // Get status from claims or attrs
      const statusClaim = details.claims?.find(
        (c: any) => c.field === "status" || c.statement?.includes("status")
      );
      const status = statusClaim
        ? ((statusClaim as any).value ?? (statusClaim as any).statement ?? "open")
        : (node.attrs?.status ?? "open");

      if (opts.format === "json") {
        console.log(JSON.stringify({
          bugId,
          title: node.name,
          description: node.attrs?.description ?? "",
          status,
          severity: node.attrs?.severity ?? "medium",
          created_at: node.attrs?.created_at ?? node.createdAt,
          affects,
          plans,
        }, null, 2));
      } else {
        console.log(`Bug: ${chalk.bold(node.name)}`);
        console.log(`  Status:   ${status}`);
        console.log(`  Severity: ${node.attrs?.severity ?? "medium"}`);
        if (node.attrs?.description) {
          console.log(`  ${chalk.dim(node.attrs.description)}`);
        }
        if (affects.length > 0) {
          console.log(`\nAffects:`);
          for (const a of affects) {
            console.log(`  ${chalk.cyan(a.kind)} ${a.name}`);
          }
        }
        if (plans.length > 0) {
          console.log(`\nPlans responding:`);
          for (const p of plans) {
            console.log(`  ${p.name} (${chalk.dim(p.id.slice(0, 8))})`);
          }
        }
      }
    });

  bug
    .command("update <bugId>")
    .description("Update a bug's status")
    .requiredOption("--status <status>", `Status (${VALID_STATUSES.join("|")})`)
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (bugId: string, opts: { status: string; format: string }) => {
      if (!VALID_STATUSES.includes(opts.status)) {
        stderr(`Invalid status "${opts.status}". Valid: ${VALID_STATUSES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const client = new IxClient(getEndpoint());
      const patch = buildBugUpdatePatch(bugId, opts.status);
      const result = await client.commitPatch(patch);
      if (opts.format === "json") {
        console.log(JSON.stringify({ bugId, status: opts.status, rev: result.rev }, null, 2));
      } else {
        console.log(`Bug ${bugId.slice(0, 8)} updated to ${opts.status} (rev ${result.rev})`);
      }
    });
}
