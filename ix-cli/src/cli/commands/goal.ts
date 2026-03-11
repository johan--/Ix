import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatIntents } from "../format.js";
import { stderr } from "../stderr.js";

export function registerGoalCommand(program: Command): void {
  const goal = program
    .command("goal")
    .description("Manage project goals")
    .addHelpText(
      "after",
      `\nSubcommands:
  create <statement>  Create a new goal (rejects duplicate names)
  show <ref>          Show goal details by ID or name
  list                List all goals

Use "ix goals" as a shorthand to list all goals.

Examples:
  ix goal create "Support GitHub ingestion"
  ix goal show "Support GitHub ingestion"
  ix goal list --format json
  ix goal list --status active --format json
  ix goals`
    );

  goal
    .command("create <statement>")
    .description("Create a new goal")
    .option("--parent <id>", "Parent goal ID")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (statement: string, opts: { parent?: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      // Check duplicate goal name
      const existing = await client.listGoals();
      const dup = existing.find(
        (i: any) => (i.name || i.statement || "").toLowerCase() === statement.toLowerCase(),
      );
      if (dup) {
        stderr(`A goal named "${statement}" already exists (${(dup as any).id.slice(0, 8)}). Use a unique name.`);
        process.exitCode = 1;
        return;
      }

      const result = await client.createGoal(statement, opts.parent);
      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Goal created: ${result.nodeId} (rev ${result.rev})`);
      }
    });

  goal
    .command("show <ref>")
    .description("Show goal details by ID or name")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (ref: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve goal reference (accepts name or ID)
      let goalId: string;
      try {
        goalId = await client.resolvePrefix(ref);
      } catch {
        const intents = await client.listGoals();
        const match = intents.find(
          (i: any) => (i.name || i.statement || "").toLowerCase() === ref.toLowerCase(),
        );
        if (!match) {
          stderr(`No goal found matching "${ref}".`);
          process.exitCode = 1;
          return;
        }
        goalId = (match as any).id;
      }

      const details = await client.entity(goalId);
      const node = details.node as any;

      // Get linked plans
      const { nodes: planNodes } = await client.expand(goalId, {
        direction: "out",
        predicates: ["GOAL_HAS_PLAN"],
      });
      const plans = planNodes.filter((n: any) => n.kind === "plan");

      if (opts.format === "json") {
        console.log(JSON.stringify({
          goalId,
          name: node.name,
          plans: plans.map((p: any) => ({ id: p.id, name: p.name })),
        }, null, 2));
      } else {
        console.log(chalk.bold(node.name));
        console.log(`  ID: ${goalId.slice(0, 8)}`);
        if (plans.length > 0) {
          console.log(chalk.dim("  Plans:"));
          for (const p of plans) {
            console.log(`    ${(p as any).name} (${(p as any).id.slice(0, 8)})`);
          }
        } else {
          console.log(chalk.dim("  No plans linked."));
        }
      }
    });

  goal
    .command("list")
    .description("List all goals")
    .option("--status <status>", "Filter by status (active|all)", "all")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { status: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      let intents = await client.listGoals();

      if (opts.status === "active") {
        // Filter to goals that have at least one plan with pending tasks
        const activeGoalIds = new Set<string>();
        const goalsToCheck = intents.slice(0, 20);

        for (const intent of goalsToCheck) {
          try {
            const { nodes: goalPlans } = await client.expand(intent.id, {
              direction: "out",
              predicates: ["GOAL_HAS_PLAN"],
            });
            for (const plan of goalPlans) {
              const { nodes: taskNodes } = await client.expand(plan.id, {
                direction: "out",
                predicates: ["PLAN_HAS_TASK"],
              });
              const hasPending = taskNodes.some(
                (t: any) => t.kind === "task" && (t.attrs?.status ?? "pending") === "pending"
              );
              if (hasPending) {
                activeGoalIds.add(intent.id);
                break;
              }
            }
          } catch {
            // Include on error to be safe
            activeGoalIds.add(intent.id);
          }
        }
        intents = intents.filter((i: any) => activeGoalIds.has(i.id));
      }

      formatIntents(intents, opts.format);
    });
}
