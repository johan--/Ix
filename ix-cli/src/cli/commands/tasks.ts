import type { Command } from "commander";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import chalk from "chalk";
import {
  STATUS_ICONS,
  getTaskStatus,
  getWorkflowState,
  formatWorkflowStateCompact,
} from "../task-utils.js";

export function registerTasksCommand(program: Command): void {
  program
    .command("tasks")
    .description("List all tasks across plans")
    .option("--status <status>", "Filter by status (pending|in_progress|blocked|done|abandoned)")
    .option("--plan <id>", "Filter to tasks in a specific plan")
    .option("--limit <n>", "Max results", "100")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .addHelpText(
      "after",
      `\nExamples:
  ix tasks
  ix tasks --status pending
  ix tasks --plan <plan-id>
  ix tasks --format json`
    )
    .action(
      async (opts: {
        status?: string;
        plan?: string;
        limit: string;
        format: string;
      }) => {
        const client = new IxClient(getEndpoint());
        const isJson = opts.format === "json";
        const limit = parseInt(opts.limit, 10);

        let taskNodes: any[];

        if (opts.plan) {
          // Get tasks for a specific plan via PLAN_HAS_TASK edges
          const { nodes } = await client.expand(opts.plan, {
            direction: "out",
            predicates: ["PLAN_HAS_TASK"],
          });
          taskNodes = nodes.filter((n: any) => n.kind === "task");
        } else {
          // Get all task nodes
          taskNodes = await client.listByKind("task", { limit });
        }

        // Fetch entity details per task to read claim-based status
        const entityDetails = await Promise.all(
          taskNodes.map((n: any) => client.entity(n.id).catch(() => null))
        );

        let results = taskNodes.map((n: any, i: number) => {
          const detail = entityDetails[i];
          const status = detail
            ? getTaskStatus(detail)
            : ((n.attrs?.status as string) ?? "pending");
          const workflowState = detail ? getWorkflowState(detail) : null;
          return {
            id: n.id,
            name: n.name || n.attrs?.name || "(unnamed)",
            status,
            planId: opts.plan ?? null,
            ...(workflowState ? { workflowState } : {}),
          };
        });

        const total = results.length;

        // Filter by status if provided
        if (opts.status) {
          results = results.filter((t) => t.status === opts.status);
        }

        if (isJson) {
          console.log(
            JSON.stringify(
              {
                results,
                summary: { total, filtered: results.length },
              },
              null,
              2
            )
          );
        } else {
          if (results.length === 0) {
            console.log(chalk.dim("No tasks found."));
            return;
          }
          console.log(chalk.bold(`Tasks (${results.length})`));
          for (const t of results) {
            const icon = STATUS_ICONS[t.status] ?? "?";
            const wfSuffix = (t as any).workflowState
              ? ` ${chalk.dim(formatWorkflowStateCompact((t as any).workflowState))}`
              : "";
            console.log(
              `  ${icon} ${chalk.dim(`[${t.status}]`.padEnd(14))} ${t.name}${wfSuffix}`
            );
          }
          if (total !== results.length) {
            console.log(chalk.dim(`\n${results.length} of ${total} tasks shown (filtered by --status ${opts.status})`));
          }
        }
      }
    );
}
