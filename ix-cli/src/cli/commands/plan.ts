import type { Command } from "commander";
import type { GraphPatchPayload, PatchOp } from "../../client/types.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { deterministicId } from "../github/transform.js";
import { resolveEntity, printResolved } from "../resolve.js";
import { stderr } from "../stderr.js";
import chalk from "chalk";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────

export interface StagedWorkflow {
  discover?: string[];
  implement?: string[];
  validate?: string[];
}

export const VALID_WORKFLOW_STAGES = ["discover", "implement", "validate"];

export function isValidWorkflow(w: unknown): w is string[] | StagedWorkflow {
  if (Array.isArray(w)) return w.every(s => typeof s === "string");
  if (typeof w === "object" && w !== null) {
    return Object.keys(w).every(k => VALID_WORKFLOW_STAGES.includes(k));
  }
  return false;
}

/** Normalize any workflow form to StagedWorkflow for display */
export function normalizeWorkflow(w: string[] | StagedWorkflow): StagedWorkflow {
  if (Array.isArray(w)) return { discover: w };
  return w;
}

/** Run workflow stages — constrained to ix commands only. */
interface WorkflowRunResult {
  stage: string;
  command: string;
  status: "ok" | "error" | "skipped";
  output?: unknown;
  error?: string;
}

async function executeIxCommand(cmd: string): Promise<unknown> {
  const trimmed = cmd.replace(/^ix\s+/, "");
  const args = trimmed.split(/\s+/);
  if (!args.includes("--format") && !args.includes("-f")) {
    args.push("--format", "json");
  }
  const { stdout } = await execFileAsync("ix", args, {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    return stdout.trim();
  }
}

async function runWorkflowStages(
  workflow: StagedWorkflow,
  stages: string[],
): Promise<WorkflowRunResult[]> {
  const results: WorkflowRunResult[] = [];
  for (const stage of stages) {
    const cmds = workflow[stage as keyof StagedWorkflow];
    if (!cmds || cmds.length === 0) continue;
    for (const cmd of cmds) {
      if (!cmd.trimStart().startsWith("ix ") && cmd.trim() !== "ix") {
        results.push({ stage, command: cmd, status: "skipped", error: "Only ix commands are allowed" });
        continue;
      }
      if (/[|;&`$()]/.test(cmd)) {
        results.push({ stage, command: cmd, status: "skipped", error: "Shell operators not allowed" });
        continue;
      }
      try {
        const output = await executeIxCommand(cmd);
        results.push({ stage, command: cmd, status: "ok", output });
      } catch (err: any) {
        results.push({ stage, command: cmd, status: "error", error: err.message || String(err) });
      }
    }
  }
  return results;
}

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
  workflow?: string[] | StagedWorkflow;
  resolves?: string;
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

  if (opts.resolves) {
    ops.push({
      type: "UpsertEdge",
      id: deterministicId(`${taskId}:TASK_RESOLVES_BUG:${opts.resolves}`),
      src: taskId,
      dst: opts.resolves,
      predicate: "TASK_RESOLVES_BUG",
      attrs: {},
    });
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
    .description("Manage plans and plan tasks")
    .addHelpText(
      "after",
      `\nSubcommands:
  create <title>   Create a new plan linked to a goal
  task <title>     Add a task to a plan
  status <planId>  Show plan status with all tasks (alias: show)
  next <planId>    Show the next actionable task

Options --goal and --plan accept IDs, UUID prefixes, or exact names.
Duplicate names within each type are rejected.

Examples:
  ix plan create "Fix auth" --goal <goal-id-or-name>
  ix plan task "Step 1" --plan <plan-id-or-name>
  ix plan create "Fix auth" --goal "Support GitHub"
  ix plan task "Step 1" --plan "Fix auth"
  ix plan show <plan-id> --format json
  ix plan next <plan-id> --with-workflow`
    );

  plan
    .command("create <title>")
    .description("Create a new plan linked to a goal")
    .requiredOption("--goal <id-or-name>", "Goal ID or name to link the plan to")
    .option("--responds-to <bugId>", "Bug ID this plan responds to (creates RESPONDS_TO edge)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { goal: string; respondsTo?: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve goal reference (accepts name or ID)
      let goalId: string;
      try {
        goalId = await client.resolvePrefix(opts.goal);
      } catch {
        const intents = await client.listTruth();
        const match = intents.find(
          (i: any) => (i.name || i.statement || "").toLowerCase() === opts.goal.toLowerCase(),
        );
        if (match) {
          goalId = (match as any).id;
        } else {
          stderr(`No goal found matching "${opts.goal}".`);
          process.exitCode = 1;
          return;
        }
      }

      // Check duplicate plan name
      const existingPlans = await client.search(title, { limit: 5, kind: "plan", nameOnly: true });
      const dupPlan = (existingPlans as any[]).find(
        (n: any) => (n.name || "").toLowerCase() === title.toLowerCase(),
      );
      if (dupPlan) {
        stderr(`A plan named "${title}" already exists (${dupPlan.id.slice(0, 8)}). Use a unique name.`);
        process.exitCode = 1;
        return;
      }

      const patch = buildPlanPatch(title, goalId, opts.respondsTo);
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
    .requiredOption("--plan <id-or-name>", "Plan ID or name")
    .option("--depends-on <id>", "Task ID this task depends on")
    .option("--affects <entities>", "Comma-separated entity names this task affects")
    .option("--workflow <commands>", "Comma-separated ix commands to run for this task")
    .option("--workflow-staged <json>", "Staged workflow as JSON (keys: discover, implement, validate)")
    .option("--resolves <bugId>", "Bug ID this task resolves (creates TASK_RESOLVES_BUG edge)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (title: string, opts: { plan: string; dependsOn?: string; affects?: string; workflow?: string; workflowStaged?: string; resolves?: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve plan reference (accepts name or ID)
      let planId: string;
      try {
        planId = await client.resolvePrefix(opts.plan);
      } catch {
        const target = await resolveEntity(client, opts.plan, ["plan"], {});
        if (!target) {
          process.exitCode = 1;
          return;
        }
        planId = target.id;
      }

      // Check duplicate task name within this plan
      const { nodes: existingTasks } = await client.expand(planId, {
        direction: "out",
        predicates: ["PLAN_HAS_TASK"],
      });
      const dupTask = existingTasks.find(
        (n: any) => n.kind === "task" && (n.name || "").toLowerCase() === title.toLowerCase(),
      );
      if (dupTask) {
        stderr(`A task named "${title}" already exists in this plan (${dupTask.id.slice(0, 8)}). Use a unique name.`);
        process.exitCode = 1;
        return;
      }

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

      let workflow: string[] | StagedWorkflow | undefined;
      if (opts.workflowStaged) {
        try {
          const parsed = JSON.parse(opts.workflowStaged);
          if (!isValidWorkflow(parsed) || Array.isArray(parsed)) {
            stderr(`Invalid staged workflow JSON. Valid keys: ${VALID_WORKFLOW_STAGES.join(", ")}`);
            process.exitCode = 1;
            return;
          }
          workflow = parsed as StagedWorkflow;
        } catch {
          stderr("Invalid JSON for --workflow-staged");
          process.exitCode = 1;
          return;
        }
      } else if (opts.workflow) {
        workflow = opts.workflow.split(",").map(s => s.trim());
      }

      const patch = buildTaskPatch(title, {
        planId,
        dependsOn: opts.dependsOn,
        affects: affectsEntities,
        workflow,
        resolves: opts.resolves,
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
    .alias("show")
    .description("Show plan status with all tasks")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve plan ID (accept name or UUID prefix)
      let resolvedPlanId = planId;
      try {
        resolvedPlanId = await client.resolvePrefix(planId);
      } catch {
        const target = await resolveEntity(client, planId, ["plan"], {});
        if (!target) return;
        resolvedPlanId = target.id;
      }

      // Expand PLAN_HAS_TASK to get all tasks
      const { nodes: taskNodes, edges: taskEdges } = await client.expand(resolvedPlanId, {
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

      // Count open bugs linked via RESPONDS_TO
      const { nodes: respondNodes } = await client.expand(resolvedPlanId, {
        direction: "out",
        predicates: ["RESPONDS_TO"],
      });
      const openBugCount = respondNodes.filter((n: any) => n.kind === "bug").length;

      const summary = {
        total: tasks.length,
        done: tasks.filter(t => t.status === "done").length,
        pending: tasks.filter(t => t.status === "pending").length,
        inProgress: tasks.filter(t => t.status === "in_progress").length,
        blocked: tasks.filter(t => t.status === "blocked").length,
        openBugCount,
      };

      if (opts.format === "json") {
        console.log(JSON.stringify({
          planId: resolvedPlanId,
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
    .option("--run-workflow", "Resolve next task and run its workflow")
    .option("--stage <stage>", "When used with --run-workflow, run only this stage")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (planId: string, opts: { withWorkflow?: boolean; runWorkflow?: boolean; stage?: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve plan ID (accept name or UUID prefix)
      let resolvedPlanId = planId;
      try {
        resolvedPlanId = await client.resolvePrefix(planId);
      } catch {
        // Try searching by name
        const target = await resolveEntity(client, planId, ["plan"], {});
        if (!target) return;
        resolvedPlanId = target.id;
      }

      const { nodes: taskNodes } = await client.expand(resolvedPlanId, {
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

      // Determine reason when no actionable task
      let noActionReason = "no actionable tasks";
      if (!nextActionable) {
        if (tasks.length === 0) {
          noActionReason = "no tasks in plan";
        } else if (tasks.every(t => t.status === "done" || t.status === "abandoned")) {
          noActionReason = "all tasks done";
        } else {
          noActionReason = "all remaining tasks blocked";
        }
      }

      // ── Run workflow if requested ──────────────────────────────────
      let workflowResults: WorkflowRunResult[] | null = null;
      let workflowData: StagedWorkflow | null = null;

      if (nextActionable && (opts.withWorkflow || opts.runWorkflow)) {
        const detail = await client.entity(nextActionable.id);
        // Check claims first (for workflows attached via `ix workflow attach`), then attrs
        const wfClaim = detail.claims?.find(
          (c: any) => c.field === "workflow" || c.statement === "workflow"
        );
        const rawWorkflow = wfClaim ? (wfClaim as any).value : detail.node?.attrs?.workflow;
        if (rawWorkflow) {
          workflowData = normalizeWorkflow(rawWorkflow as string[] | StagedWorkflow);
        }
      }

      if (nextActionable && opts.runWorkflow && workflowData) {
        let stagesToRun = [...VALID_WORKFLOW_STAGES];
        if (opts.stage) {
          if (!VALID_WORKFLOW_STAGES.includes(opts.stage)) {
            stderr(`Invalid stage "${opts.stage}". Valid: ${VALID_WORKFLOW_STAGES.join(", ")}`);
            return;
          }
          stagesToRun = [opts.stage];
        }
        workflowResults = await runWorkflowStages(workflowData, stagesToRun);
      }

      // ── Output ─────────────────────────────────────────────────────
      if (opts.format === "json") {
        if (nextActionable) {
          const result: Record<string, unknown> = {
            task: nextActionable.title,
            taskId: nextActionable.id,
            reason: "all dependencies satisfied",
          };
          if (workflowData) {
            result.workflow = workflowData;
          }
          if (workflowResults) {
            result.workflowResults = workflowResults;
          }
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(JSON.stringify({ task: null, reason: noActionReason }, null, 2));
        }
      } else {
        if (nextActionable) {
          console.log(`${chalk.green("Next:")} ${nextActionable.title} (${nextActionable.id.slice(0, 8)})`);
          if (workflowData) {
            console.log(chalk.dim("Workflow:"));
            for (const stage of VALID_WORKFLOW_STAGES) {
              const cmds = workflowData[stage as keyof StagedWorkflow];
              if (cmds && cmds.length > 0) {
                console.log(`  ${chalk.bold(stage)}:`);
                for (const cmd of cmds) {
                  console.log(`    ${chalk.cyan("▸")} ${cmd}`);
                }
              }
            }
          }
          if (workflowResults) {
            console.log();
            for (const r of workflowResults) {
              const icon = r.status === "ok" ? chalk.green("✓")
                : r.status === "error" ? chalk.red("✗")
                : chalk.yellow("⊘");
              console.log(`  ${icon} ${chalk.dim(`[${r.stage}]`)} ${r.command}`);
              if (r.status === "error" && r.error) {
                console.log(`    ${chalk.red(r.error)}`);
              }
            }
            const ok = workflowResults.filter(r => r.status === "ok").length;
            const err = workflowResults.filter(r => r.status === "error").length;
            const skip = workflowResults.filter(r => r.status === "skipped").length;
            console.log(chalk.dim(`\nDone: ${ok} ok, ${err} error, ${skip} skipped`));
          }
        } else {
          console.log(chalk.dim(`No actionable tasks: ${noActionReason}`));
        }
      }
    });
}

export function registerTaskCommand(program: Command): void {
  const task = program
    .command("task")
    .description("Manage tasks")
    .addHelpText(
      "after",
      `\nSubcommands:
  show <taskId>    Show task details
  update <taskId>  Update a task's status

Examples:
  ix task show <task-id> --with-workflow
  ix task update <task-id> --status done`
    );

  task
    .command("show <taskId>")
    .description("Show task details")
    .option("--with-workflow", "Include workflow commands in output")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (taskId: string, opts: { withWorkflow?: boolean; format: string }) => {
      const client = new IxClient(getEndpoint());

      // Resolve task ID (accept name or UUID prefix)
      let resolvedTaskId = taskId;
      try {
        resolvedTaskId = await client.resolvePrefix(taskId);
      } catch {
        const target = await resolveEntity(client, taskId, ["task"], {});
        if (!target) return;
        resolvedTaskId = target.id;
      }

      const details = await client.entity(resolvedTaskId);
      const node = details.node as any;

      const statusClaim = details.claims?.find(
        (c: any) => c.field === "status" || c.statement?.includes("status")
      );
      const status = statusClaim
        ? ((statusClaim as any).value ?? (statusClaim as any).statement ?? "pending")
        : (node.attrs?.status ?? "pending");

      // Check claims first (for workflows attached via `ix workflow attach`), then attrs
      const workflowClaim = details.claims?.find(
        (c: any) => c.field === "workflow" || c.statement === "workflow"
      );
      const rawWorkflow = (workflowClaim ? (workflowClaim as any).value : node.attrs?.workflow) as string[] | StagedWorkflow | undefined;

      if (opts.format === "json") {
        const result: Record<string, unknown> = {
          taskId: resolvedTaskId,
          title: node.name,
          status,
          created_at: node.attrs?.created_at ?? node.createdAt,
        };
        if (opts.withWorkflow) {
          result.workflow = rawWorkflow
            ? normalizeWorkflow(rawWorkflow)
            : {};
        }
        console.log(JSON.stringify(result, null, 2));
      } else {
        const icon = STATUS_ICONS[status] ?? "?";
        console.log(`${icon} ${chalk.bold(node.name)}`);
        console.log(`  Status: ${status}`);
        if (opts.withWorkflow && rawWorkflow) {
          const staged = normalizeWorkflow(rawWorkflow);
          console.log(chalk.dim("  Workflow:"));
          for (const stage of VALID_WORKFLOW_STAGES) {
            const cmds = staged[stage as keyof StagedWorkflow];
            if (cmds && cmds.length > 0) {
              console.log(`    ${chalk.bold(stage)}:`);
              for (const cmd of cmds) {
                console.log(`      ${chalk.cyan("▸")} ${cmd}`);
              }
            }
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
