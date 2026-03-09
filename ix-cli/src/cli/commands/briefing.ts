import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import chalk from "chalk";

interface BriefingGoal {
  id: string;
  name: string;
}

interface BriefingPlan {
  id: string;
  name: string;
  taskSummary: { total: number; done: number; pending: number };
  nextTask: string | null;
}

interface BriefingBug {
  id: string;
  title: string;
  severity: string;
  status: string;
}

interface BriefingDecision {
  id: string;
  name: string;
  rationale: string;
}

interface BriefingChange {
  patchId: string;
  intent: string | null;
  rev: number;
}

export interface BriefingResult {
  lastIngestAt: string | null;
  revision: number | null;
  activeGoals: BriefingGoal[];
  activePlans: BriefingPlan[];
  openBugs: BriefingBug[];
  recentDecisions: BriefingDecision[];
  recentChanges: BriefingChange[];
  conflicts: unknown[];
  diagnostics: string[];
}

export async function buildBriefing(client: IxClient): Promise<BriefingResult> {
  const diagnostics: string[] = [];

  // Fetch all data sources in parallel
  const [healthResult, goals, plans, bugs, decisions, patches, conflicts] =
    await Promise.all([
      client.health().catch(() => {
        diagnostics.push("health endpoint unreachable");
        return null;
      }),
      client.listByKind("intent", { limit: 50 }).catch(() => {
        diagnostics.push("could not list goals");
        return [] as any[];
      }),
      client.listByKind("plan", { limit: 50 }).catch(() => {
        diagnostics.push("could not list plans");
        return [] as any[];
      }),
      client.listByKind("bug", { limit: 50 }).catch(() => {
        diagnostics.push("could not list bugs");
        return [] as any[];
      }),
      client.listDecisions({ limit: 5 }).catch(() => {
        diagnostics.push("could not list decisions");
        return [] as any[];
      }),
      client.listPatches({ limit: 10 }).catch(() => {
        diagnostics.push("could not list patches");
        return [] as any[];
      }),
      client.conflicts().catch(() => {
        diagnostics.push("could not check conflicts");
        return [] as unknown[];
      }),
    ]);

  // Extract last ingest time and revision from patches
  let lastIngestAt: string | null = null;
  let revision: number | null = null;
  if (patches.length > 0) {
    const latest = patches[0] as any;
    lastIngestAt = latest.timestamp ?? null;
    revision = latest.rev ?? null;
  }

  // Map goals
  const activeGoals: BriefingGoal[] = goals.map((g: any) => ({
    id: g.id,
    name: g.name ?? g.attrs?.statement ?? "(unnamed)",
  }));

  // Map bugs — filter to open/investigating only
  const openBugs: BriefingBug[] = bugs
    .filter((b: any) => {
      const status = b.attrs?.status ?? "open";
      return status === "open" || status === "investigating";
    })
    .map((b: any) => ({
      id: b.id,
      title: b.name,
      severity: b.attrs?.severity ?? "medium",
      status: b.attrs?.status ?? "open",
    }));

  // Map decisions
  const recentDecisions: BriefingDecision[] = decisions.map((d: any) => ({
    id: d.id,
    name: d.name ?? d.title ?? "(unnamed)",
    rationale: d.attrs?.rationale ?? d.rationale ?? "",
  }));

  // Map patches/changes
  const recentChanges: BriefingChange[] = patches.map((p: any) => ({
    patchId: p.patch_id ?? p.patchId ?? p.id,
    intent: p.intent ?? null,
    rev: p.rev ?? 0,
  }));

  // Enrich plans with task summaries (up to 5 plans)
  const activePlans: BriefingPlan[] = [];
  const plansToProcess = plans.slice(0, 5);

  for (const plan of plansToProcess) {
    try {
      const { nodes: taskNodes } = await client.expand(plan.id, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });

      const tasks = taskNodes.filter((n: any) => n.kind === "task");
      let doneCount = 0;
      let pendingCount = 0;
      let nextTask: string | null = null;

      // Get status for each task
      const doneIds = new Set<string>();
      const taskDetails: { id: string; name: string; status: string; dependsOn: string[] }[] = [];

      for (const t of tasks) {
        const detail = await client.entity(t.id);
        const statusClaim = detail.claims?.find(
          (c: any) => c.field === "status" || c.statement?.includes("status")
        );
        let status = "pending";
        if (statusClaim) {
          const val = (statusClaim as any).value ?? (statusClaim as any).statement;
          if (typeof val === "string") status = val;
        } else if (detail.node?.attrs?.status) {
          status = detail.node.attrs.status as string;
        }

        if (status === "done") {
          doneCount++;
          doneIds.add(t.id);
        } else if (status === "pending") {
          pendingCount++;
        }

        const { edges: depEdges } = await client.expand(t.id, {
          direction: "out",
          predicates: ["DEPENDS_ON"],
        });
        taskDetails.push({
          id: t.id,
          name: t.name,
          status,
          dependsOn: depEdges.map((e: any) => e.dst as string),
        });
      }

      // Find next actionable
      const actionable = taskDetails.find(
        (t) =>
          t.status !== "done" &&
          t.status !== "abandoned" &&
          t.dependsOn.every((dep) => doneIds.has(dep))
      );
      if (actionable) nextTask = actionable.name;

      activePlans.push({
        id: plan.id,
        name: plan.name ?? "(unnamed)",
        taskSummary: { total: tasks.length, done: doneCount, pending: pendingCount },
        nextTask,
      });
    } catch {
      activePlans.push({
        id: plan.id,
        name: plan.name ?? "(unnamed)",
        taskSummary: { total: 0, done: 0, pending: 0 },
        nextTask: null,
      });
    }
  }

  return {
    lastIngestAt,
    revision,
    activeGoals,
    activePlans,
    openBugs,
    recentDecisions,
    recentChanges,
    conflicts,
    diagnostics,
  };
}

export function registerBriefingCommand(program: Command): void {
  program
    .command("briefing")
    .description("Session-resume briefing — aggregated project status")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const briefing = await buildBriefing(client);

      if (opts.format === "json") {
        console.log(JSON.stringify(briefing, null, 2));
      } else {
        // Header
        console.log(chalk.bold("Ix Briefing"));
        if (briefing.revision !== null) {
          console.log(chalk.dim(`  Revision: ${briefing.revision}`));
        }
        if (briefing.lastIngestAt) {
          console.log(chalk.dim(`  Last ingest: ${briefing.lastIngestAt}`));
        }

        // Goals
        if (briefing.activeGoals.length > 0) {
          console.log(`\n${chalk.bold("Goals")} (${briefing.activeGoals.length})`);
          for (const g of briefing.activeGoals) {
            console.log(`  ${chalk.cyan("◆")} ${g.name}`);
          }
        }

        // Plans
        if (briefing.activePlans.length > 0) {
          console.log(`\n${chalk.bold("Plans")} (${briefing.activePlans.length})`);
          for (const p of briefing.activePlans) {
            const { done, total } = p.taskSummary;
            console.log(`  ${chalk.cyan("▸")} ${p.name} ${chalk.dim(`(${done}/${total} done)`)}`);
            if (p.nextTask) {
              console.log(`    ${chalk.green("Next:")} ${p.nextTask}`);
            }
          }
        }

        // Bugs
        if (briefing.openBugs.length > 0) {
          console.log(`\n${chalk.bold("Open Bugs")} (${briefing.openBugs.length})`);
          for (const b of briefing.openBugs) {
            const sev = b.severity === "critical" || b.severity === "high"
              ? chalk.red(b.severity)
              : chalk.yellow(b.severity);
            console.log(`  ${chalk.red("○")} ${b.title} ${chalk.dim(`[${sev}]`)}`);
          }
        }

        // Decisions
        if (briefing.recentDecisions.length > 0) {
          console.log(`\n${chalk.bold("Recent Decisions")} (${briefing.recentDecisions.length})`);
          for (const d of briefing.recentDecisions) {
            console.log(`  ${chalk.magenta("◇")} ${d.name}`);
            if (d.rationale) {
              console.log(`    ${chalk.dim(d.rationale.slice(0, 80))}`);
            }
          }
        }

        // Changes
        if (briefing.recentChanges.length > 0) {
          console.log(`\n${chalk.bold("Recent Changes")} (${briefing.recentChanges.length})`);
          for (const c of briefing.recentChanges) {
            const label = c.intent ?? chalk.dim("(no intent)");
            console.log(`  rev ${chalk.dim(String(c.rev))} ${label}`);
          }
        }

        // Conflicts
        if (briefing.conflicts.length > 0) {
          console.log(`\n${chalk.red.bold("Conflicts")} (${briefing.conflicts.length})`);
          for (const c of briefing.conflicts as any[]) {
            console.log(`  ${chalk.red("⚠")} ${c.reason ?? JSON.stringify(c)}`);
          }
        }

        // Diagnostics
        if (briefing.diagnostics.length > 0) {
          console.log(`\n${chalk.yellow("Diagnostics:")}`);
          for (const d of briefing.diagnostics) {
            console.log(`  ${chalk.yellow("!")} ${d}`);
          }
        }
      }
    });
}
