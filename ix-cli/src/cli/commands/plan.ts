import type { Command } from "commander";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { deterministicId } from "../github/transform.js";
import { resolveEntity, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";
import chalk from "chalk";

// ── Patch builders (exported for testing) ──────────────────────────

function makePatchEnvelope(ops: PatchOp[], intent?: string): GraphPatchPayload {
  return {
    patchId: deterministicId(`plan-patch-${Date.now()}-${Math.random()}`),
    actor: "ix-cli",
    timestamp: new Date().toISOString(),
    source: {
      uri: "ix-cli://plan",
      extractor: "ix-cli-plan",
      sourceType: "cli",
    },
    baseRev: 0,
    ops,
    replaces: [],
    intent,
  };
}

export function buildPlanPatch(title: string, goalId: string, respondsTo?: string): GraphPatchPayload {
  const planId = deterministicId(`plan:${title}:${goalId}`);
  const edgeId = deterministicId(`${goalId}:GOAL_HAS_PLAN:${planId}`);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: planId,
      kind: "plan",
      name: title,
      attrs: { created_at: new Date().toISOString() },
    },
    {
      type: "UpsertEdge",
      id: edgeId,
      src: goalId,
      dst: planId,
      predicate: "GOAL_HAS_PLAN",
      attrs: {},
    },
  ];

  if (respondsTo) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${planId}:RESPONDS_TO:${respondsTo}`),
      src: planId,
      dst: respondsTo,
      predicate: "RESPONDS_TO",
      attrs: {},
    });
  }

  return makePatchEnvelope(ops, `Create plan: ${title}`);
}

export interface TaskOpts {
  planId: string;
  dependsOn?: string;
  affects?: { id: string; kind: string; name: string }[];
  workflow?: string[];
}

export function buildTaskPatch(title: string, opts: TaskOpts): GraphPatchPayload {
  const taskId = deterministicId(`task:${title}:${opts.planId}`);
  const edgeId = deterministicId(`${opts.planId}:PLAN_HAS_TASK:${taskId}`);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: taskId,
      kind: "task",
      name: title,
      attrs: {
        status: "pending",
        created_at: new Date().toISOString(),
        ...(opts.workflow ? { workflow: opts.workflow } : {}),
      },
    },
    {
      type: "UpsertEdge",
      id: edgeId,
      src: opts.planId,
      dst: taskId,
      predicate: "PLAN_HAS_TASK",
      attrs: {},
    },
  ];

  if (opts.dependsOn) {
    const depEdgeId = deterministicId(`${taskId}:DEPENDS_ON:${opts.dependsOn}`);
    ops.push({
      type: "UpsertEdge",
      id: depEdgeId,
      src: taskId,
      dst: opts.dependsOn,
      predicate: "DEPENDS_ON",
      attrs: {},
    });
  }

  if (opts.affects) {
    for (const entity of opts.affects) {
      const affectsEdgeId = deterministicId(`${taskId}:TASK_AFFECTS:${entity.id}`);
      ops.push({
        type: "UpsertEdge",
        id: affectsEdgeId,
        src: taskId,
        dst: entity.id,
        predicate: "TASK_AFFECTS",
        attrs: { kind: entity.kind, name: entity.name },
      });
    }
  }

  return makePatchEnvelope(ops, `Create task: ${title}`);
}

export function buildTaskUpdatePatch(taskId: string, status: string): GraphPatchPayload {
  const ops: PatchOp[] = [
    {
      type: "AssertClaim",
      entityId: taskId,
      field: "status",
      value: status,
      confidence: 1.0,
    },
  ];
  return makePatchEnvelope(ops, `Update task ${taskId} status to ${status}`);
}

// ── CLI commands ───────────────────────────────────────────────────

const VALID_STATUSES = ["pending", "in_progress", "blocked", "done", "abandoned"];

const STATUS_ICONS: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  blocked: "✖",
  done: "●",
  abandoned: "⊘",
};

export function registerPlanCommand(program: Command): void {
  const plan = program
    .command("plan")
    .description("Manage plans and plan tasks");

  plan
    .command("create <title>")
    .description("Create a new plan linked to a goal")
    .requiredOption("--goal <id>", "Goal ID to link the plan to")
    .option("--responds-to <bugId>", "Bug ID this plan responds to (creates RESPONDS_TO edge)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { goal: string; respondsTo?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const patch = buildPlanPatch(title, opts.goal, opts.respondsTo);
      const result = await client.commitPatch(patch);
      const planId = patch.ops[0].id as string;
      if (opts.format === "json") {
        console.log(JSON.stringify({ planId, rev: result.rev, status: result.status }, null, 2));
      } else {
        console.log(`Plan created: ${planId} (rev ${result.rev})`);
      }
    });

  plan
    .command("task <title>")
    .description("Add a task to a plan")
    .requiredOption("--plan <id>", "Plan ID")
    .option("--depends-on <id>", "Task ID this task depends on")
    .option("--affects <entities>", "Comma-separated entity names this task affects")
    .option("--workflow <commands>", "Comma-separated ix commands to run for this task")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { plan: string; dependsOn?: string; affects?: string; workflow?: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      let affectsEntities: { id: string; kind: string; name: string }[] | undefined;
      if (opts.affects) {
        const names = opts.affects.split(",").map(s => s.trim());
        affectsEntities = [];
        for (const name of names) {
          const resolved = await resolveEntity(client, name, ["class", "function", "module", "file"]);
          if (!resolved) {
            stderr(`Could not resolve entity: ${name}`);
            process.exitCode = 1;
            return;
          }
          affectsEntities.push({ id: resolved.id, kind: resolved.kind, name: resolved.name });
        }
      }

      const workflowArr = opts.workflow
        ? opts.workflow.split(",").map(s => s.trim())
        : undefined;

      const patch = buildTaskPatch(title, {
        planId: opts.plan,
        dependsOn: opts.dependsOn,
        affects: affectsEntities,
        workflow: workflowArr,
      });
      const result = await client.commitPatch(patch);
      const taskId = patch.ops[0].id as string;
      if (opts.format === "json") {
        console.log(JSON.stringify({ taskId, rev: result.rev, status: result.status }, null, 2));
      } else {
        console.log(`Task created: ${taskId} (rev ${result.rev})`);
      }
    });

  plan
    .command("status <planId>")
    .description("Show plan status with all tasks")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Expand PLAN_HAS_TASK to get all tasks
      const { nodes: taskNodes, edges: taskEdges } = await client.expand(planId, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });

      const tasks: { id: string; title: string; status: string; dependsOn: string[] }[] = [];

      for (const node of taskNodes) {
        if (node.kind !== "task") continue;
        // Get entity details for status and deps
        const entityDetail = await client.entity(node.id);
        const status = getTaskStatus(entityDetail);

        // Expand DEPENDS_ON for this task
        const { edges: depEdges } = await client.expand(node.id, {
          direction: "out",
          predicates: ["DEPENDS_ON"],
        });
        const dependsOn = depEdges.map((e: any) => e.dst as string);

        tasks.push({
          id: node.id,
          title: node.name,
          status,
          dependsOn,
        });
      }

      // Build a set of done task IDs
      const doneIds = new Set(tasks.filter(t => t.status === "done").map(t => t.id));

      // Next actionable: not done, all deps satisfied
      const nextActionable = tasks.find(t =>
        t.status !== "done" && t.status !== "abandoned" &&
        t.dependsOn.every(dep => doneIds.has(dep))
      );

      // Critical path: tasks with most downstream dependents
      const downstreamCount = new Map<string, number>();
      for (const t of tasks) {
        downstreamCount.set(t.id, 0);
      }
      for (const t of tasks) {
        for (const dep of t.dependsOn) {
          downstreamCount.set(dep, (downstreamCount.get(dep) ?? 0) + 1);
        }
      }
      const criticalPath = [...downstreamCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .filter(([, count]) => count > 0)
        .map(([id]) => id);

      const summary = {
        total: tasks.length,
        done: tasks.filter(t => t.status === "done").length,
        pending: tasks.filter(t => t.status === "pending").length,
        inProgress: tasks.filter(t => t.status === "in_progress").length,
        blocked: tasks.filter(t => t.status === "blocked").length,
      };

      if (opts.format === "json") {
        console.log(JSON.stringify({
          planId,
          tasks: tasks.map(t => ({ title: t.title, status: t.status, id: t.id })),
          criticalPath,
          nextActionable: nextActionable ? nextActionable.id : null,
          summary,
        }, null, 2));
      } else {
        for (const t of tasks) {
          const icon = STATUS_ICONS[t.status] ?? "?";
          console.log(`  ${icon} ${chalk.dim(`[${t.status}]`.padEnd(14))} ${t.title}`);
        }
        if (nextActionable) {
          console.log(`\n${chalk.green("Next:")} ${nextActionable.title}`);
        }
        console.log(chalk.dim(`\n${summary.done}/${summary.total} done`));
      }
    });

  plan
    .command("next <planId>")
    .description("Show the next actionable task in a plan")
    .option("--with-workflow", "Include workflow commands in output")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { withWorkflow?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());

      const { nodes: taskNodes } = await client.expand(planId, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });

      const tasks: { id: string; title: string; status: string; dependsOn: string[] }[] = [];

      for (const node of taskNodes) {
        if (node.kind !== "task") continue;
        const entityDetail = await client.entity(node.id);
        const status = getTaskStatus(entityDetail);

        const { edges: depEdges } = await client.expand(node.id, {
          direction: "out",
          predicates: ["DEPENDS_ON"],
        });
        const dependsOn = depEdges.map((e: any) => e.dst as string);

        tasks.push({ id: node.id, title: node.name, status, dependsOn });
      }

      const doneIds = new Set(tasks.filter(t => t.status === "done").map(t => t.id));
      const nextActionable = tasks.find(t =>
        t.status !== "done" && t.status !== "abandoned" &&
        t.dependsOn.every(dep => doneIds.has(dep))
      );

      if (opts.format === "json") {
        if (nextActionable) {
          const result: Record<string, unknown> = {
            task: nextActionable.title,
            taskId: nextActionable.id,
            reason: "all dependencies satisfied",
          };
          if (opts.withWorkflow) {
            const detail = await client.entity(nextActionable.id);
            const workflow = (detail.node?.attrs?.workflow as string[] | undefined) ?? [];
            result.workflow = workflow;
          }
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(JSON.stringify({ task: null, reason: "no actionable tasks" }, null, 2));
        }
      } else {
        if (nextActionable) {
          console.log(`${chalk.green("Next:")} ${nextActionable.title} (${nextActionable.id.slice(0, 8)})`);
          if (opts.withWorkflow) {
            const detail = await client.entity(nextActionable.id);
            const workflow = (detail.node?.attrs?.workflow as string[] | undefined) ?? [];
            if (workflow.length > 0) {
              console.log(chalk.dim("Workflow:"));
              for (const cmd of workflow) {
                console.log(`  ${chalk.cyan("▸")} ${cmd}`);
              }
            }
          }
        } else {
          console.log(chalk.dim("No actionable tasks."));
        }
      }
    });
}

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage tasks");

  task
    .command("show <taskId>")
    .description("Show task details")
    .option("--with-workflow", "Include workflow commands in output")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (taskId: string, opts: { withWorkflow?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());
      const details = await client.entity(taskId);
      const node = details.node as any;

      const statusClaim = details.claims?.find(
        (c: any) => c.field === "status" || c.statement?.includes("status")
      );
      const status = statusClaim
        ? ((statusClaim as any).value ?? (statusClaim as any).statement ?? "pending")
        : (node.attrs?.status ?? "pending");

      const workflow = (node.attrs?.workflow as string[] | undefined) ?? [];

      if (opts.format === "json") {
        const result: Record<string, unknown> = {
          taskId,
          title: node.name,
          status,
          created_at: node.attrs?.created_at ?? node.createdAt,
        };
        if (opts.withWorkflow) {
          result.workflow = workflow;
        }
        console.log(JSON.stringify(result, null, 2));
      } else {
        const icon = STATUS_ICONS[status] ?? "?";
        console.log(`${icon} ${chalk.bold(node.name)}`);
        console.log(`  Status: ${status}`);
        if (opts.withWorkflow && workflow.length > 0) {
          console.log(chalk.dim("  Workflow:"));
          for (const cmd of workflow) {
            console.log(`    ${chalk.cyan("▸")} ${cmd}`);
          }
        }
      }
    });

  task
    .command("update <taskId>")
    .description("Update a task's status")
    .requiredOption("--status <status>", `Status (${VALID_STATUSES.join("|")})`)
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (taskId: string, opts: { status: string; format: string }) => {
      if (!VALID_STATUSES.includes(opts.status)) {
        stderr(`Invalid status "${opts.status}". Valid: ${VALID_STATUSES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const client = new IxClient(getEndpoint());
      const patch = buildTaskUpdatePatch(taskId, opts.status);
      const result = await client.commitPatch(patch);
      if (opts.format === "json") {
        console.log(JSON.stringify({ taskId, status: opts.status, rev: result.rev }, null, 2));
      } else {
        console.log(`Task ${taskId.slice(0, 8)} updated to ${opts.status} (rev ${result.rev})`);
      }
    });
}

// ── Helpers ────────────────────────────────────────────────────────

function getTaskStatus(entityDetail: { node: any; claims: any[]; edges: any[] }): string {
  // Check claims first (status updates come via AssertClaim)
  const statusClaim = entityDetail.claims?.find(
    (c: any) => c.field === "status" || c.statement?.includes("status")
  );
  if (statusClaim) {
    const val = (statusClaim as any).value ?? (statusClaim as any).statement;
    if (typeof val === "string" && VALID_STATUSES.includes(val)) return val;
  }
  // Fall back to node attrs
  const attrStatus = entityDetail.node?.attrs?.status;
  if (typeof attrStatus === "string") return attrStatus;
  return "pending";
}
