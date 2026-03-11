import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatIntents } from "../format.js";

export function registerGoalsCommand(program: Command): void {
  program
    .command("goals")
    .description("List all goals")
    .option("--status <status>", "Filter by status (active|all)", "all")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (opts: { status: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      let intents = await client.listGoals();

      if (opts.status === "active") {
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
            activeGoalIds.add(intent.id);
          }
        }
        intents = intents.filter((i: any) => activeGoalIds.has(i.id));
      }

      formatIntents(intents, opts.format);
    });
}
