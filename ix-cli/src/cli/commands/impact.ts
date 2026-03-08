import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { resolveEntity, printResolved } from "../resolve.js";

const CONTAINER_KINDS = new Set(["class", "module", "file", "object", "trait", "interface"]);

export function registerImpactCommand(program: Command): void {
  program
    .command("impact <target>")
    .description("Aggregated impact analysis — who depends on this symbol and its members")
    .option("--kind <kind>", "Filter target entity by kind")
    .option("--depth <n>", "Expansion depth (reserved for future use)", "1")
    .option("--limit <n>", "Max top-impacted members to show", "10")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      "\nExamples:\n  ix impact IngestionService\n  ix impact IngestionService --kind class\n  ix impact verify_token --format json\n  ix impact AuthProvider --limit 5"
    )
    .action(
      async (
        symbol: string,
        opts: { kind?: string; depth: string; limit: string; format: string }
      ) => {
        const client = new IxClient(getEndpoint());
        const limit = parseInt(opts.limit, 10);
        const isJson = opts.format === "json";

        const target = await resolveEntity(
          client,
          symbol,
          ["class", "module", "file", "object", "trait", "interface", "method", "function"],
          opts
        );
        if (!target) return;

        if (!isJson) printResolved(target);

        if (CONTAINER_KINDS.has(target.kind)) {
          await containerImpact(client, target, limit, isJson);
        } else {
          await leafImpact(client, target, isJson);
        }
      }
    );
}

async function containerImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  limit: number,
  isJson: boolean
): Promise<void> {
  const diagnostics: string[] = [];

  // 1. Get contained members
  const containsResult = await client.expand(target.id, {
    direction: "out",
    predicates: ["CONTAINS"],
  });
  const members = containsResult.nodes;

  // 2. Get direct importers
  const importersResult = await client.expand(target.id, {
    direction: "in",
    predicates: ["IMPORTS"],
  });
  const directImporters = importersResult.nodes;

  // 3. Get direct dependents (callers of the container itself)
  const dependentsResult = await client.expand(target.id, {
    direction: "in",
    predicates: ["CALLS"],
  });
  const directDependents = dependentsResult.nodes;

  // 4. For each member (up to 20), get inbound callers
  const membersToCheck = members.slice(0, 20);
  const memberCallerCounts: { name: string; kind: string; id: string; callerCount: number }[] = [];
  let totalMemberCallers = 0;

  const callerPromises = membersToCheck.map(async (member: any) => {
    try {
      const callersResult = await client.expand(member.id, {
        direction: "in",
        predicates: ["CALLS"],
      });
      return {
        name: member.name || member.attrs?.name || "(unnamed)",
        kind: member.kind || "unknown",
        id: member.id,
        callerCount: callersResult.nodes.length,
      };
    } catch {
      diagnostics.push(`Failed to expand callers for member ${member.id}`);
      return {
        name: member.name || member.attrs?.name || "(unnamed)",
        kind: member.kind || "unknown",
        id: member.id,
        callerCount: 0,
      };
    }
  });

  const callerResults = await Promise.all(callerPromises);
  for (const r of callerResults) {
    memberCallerCounts.push(r);
    totalMemberCallers += r.callerCount;
  }

  // 5. Rank by caller count, top N
  memberCallerCounts.sort((a, b) => b.callerCount - a.callerCount);
  const topMembers = memberCallerCounts.filter((m) => m.callerCount > 0).slice(0, limit);

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          summary: {
            members: members.length,
            directImporters: directImporters.length,
            directDependents: directDependents.length,
            memberLevelCallers: totalMemberCallers,
          },
          topImpactedMembers: topMembers,
          diagnostics,
        },
        null,
        2
      )
    );
  } else {
    console.log(chalk.bold(`Target: ${target.kind} ${target.name}\n`));
    console.log(chalk.bold("Impact summary:"));
    console.log(`  members:              ${members.length}`);
    console.log(`  direct importers:     ${directImporters.length}`);
    console.log(`  direct dependents:    ${directDependents.length}`);
    console.log(`  member-level callers: ${totalMemberCallers}`);

    if (topMembers.length > 0) {
      console.log(chalk.bold("\nTop impacted members:"));
      for (const m of topMembers) {
        const kindStr = chalk.cyan(m.kind.padEnd(10));
        const nameStr = chalk.white(m.name.padEnd(20));
        console.log(`  ${kindStr} ${nameStr} ${m.callerCount} callers`);
      }
    } else {
      console.log(chalk.dim("\nNo member-level callers found."));
    }

    if (diagnostics.length > 0) {
      console.log(chalk.dim(`\nDiagnostics: ${diagnostics.join("; ")}`));
    }
  }
}

async function leafImpact(
  client: IxClient,
  target: { id: string; kind: string; name: string; resolutionMode: string },
  isJson: boolean
): Promise<void> {
  // 1. Get direct callers
  const callersResult = await client.expand(target.id, {
    direction: "in",
    predicates: ["CALLS"],
  });

  // 2. Get direct callees
  const calleesResult = await client.expand(target.id, {
    direction: "out",
    predicates: ["CALLS"],
  });

  if (isJson) {
    console.log(
      JSON.stringify(
        {
          resolvedTarget: { id: target.id, kind: target.kind, name: target.name },
          resolutionMode: target.resolutionMode,
          resultSource: "graph",
          summary: {
            callers: callersResult.nodes.length,
            callees: calleesResult.nodes.length,
          },
          callerList: callersResult.nodes.map((n: any) => ({
            id: n.id,
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })),
          calleeList: calleesResult.nodes.map((n: any) => ({
            id: n.id,
            kind: n.kind,
            name: n.name || n.attrs?.name || "(unnamed)",
          })),
          diagnostics: [],
        },
        null,
        2
      )
    );
  } else {
    console.log(chalk.bold(`Target: ${target.kind} ${target.name}\n`));
    console.log(chalk.bold("Impact summary:"));
    console.log(`  callers: ${callersResult.nodes.length}`);
    console.log(`  callees: ${calleesResult.nodes.length}`);

    if (callersResult.nodes.length > 0) {
      console.log(chalk.bold("\nCallers:"));
      for (const n of callersResult.nodes) {
        const node = n as any;
        const kindStr = chalk.cyan((node.kind || "").padEnd(10));
        const name = node.name || node.attrs?.name || "(unnamed)";
        console.log(`  ${kindStr} ${name}`);
      }
    }

    if (calleesResult.nodes.length > 0) {
      console.log(chalk.bold("\nCallees:"));
      for (const n of calleesResult.nodes) {
        const node = n as any;
        const kindStr = chalk.cyan((node.kind || "").padEnd(10));
        const name = node.name || node.attrs?.name || "(unnamed)";
        console.log(`  ${kindStr} ${name}`);
      }
    }
  }
}
