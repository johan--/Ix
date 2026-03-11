import * as fs from "node:fs";
import type { Command } from "commander";
import chalk from "chalk";
import type { PatchOp, GraphPatchPayload } from "../../client/types.js";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { deterministicId } from "../github/transform.js";
import {
  type StagedWorkflow,
  isValidWorkflow,
  normalizeWorkflow,
  extractWorkflow,
  VALID_WORKFLOW_STAGES,
  runWorkflowStages,
  type WorkflowRunResult,
} from "../task-utils.js";
import { stderr } from "../stderr.js";

// ── Helpers ────────────────────────────────────────────────────────

async function resolveTargetEntity(
  client: IxClient,
  targetType: string,
  targetId: string,
): Promise<{ node: any; claims: any[]; edges: any[] } | null> {
  const validTypes = ["task", "plan", "decision"];
  if (!validTypes.includes(targetType)) {
    stderr(`Invalid target type "${targetType}". Valid: ${validTypes.join(", ")}`);
    return null;
  }

  let resolvedId = targetId;
  try {
    resolvedId = await client.resolvePrefix(targetId);
  } catch {
    // Try search by name
    const nodes = await client.search(targetId, { limit: 5, kind: targetType, nameOnly: true });
    const match = (nodes as any[]).find(
      (n: any) => (n.name || "").toLowerCase() === targetId.toLowerCase(),
    );
    if (match) {
      resolvedId = match.id;
    } else if (nodes.length > 0) {
      resolvedId = (nodes[0] as any).id;
    } else {
      stderr(`No ${targetType} found matching "${targetId}".`);
      return null;
    }
  }

  try {
    return await client.entity(resolvedId);
  } catch {
    stderr(`Entity not found: ${resolvedId}`);
    return null;
  }
}


// ── Patch builder ─────────────────────────────────────────────────

export function buildWorkflowAttachPatch(
  entityId: string,
  workflow: string[] | StagedWorkflow,
): GraphPatchPayload {
  const ops: PatchOp[] = [
    {
      type: "AssertClaim",
      entityId,
      field: "workflow",
      value: workflow,
      confidence: 1.0,
    },
  ];
  return {
    patchId: deterministicId(`workflow-attach-${entityId}-${Date.now()}-${Math.random()}`),
    actor: "ix-cli",
    timestamp: new Date().toISOString(),
    source: {
      uri: "ix-cli://workflow",
      extractor: "ix-cli-workflow",
      sourceType: "cli",
    },
    baseRev: 0,
    ops,
    replaces: [],
    intent: `Attach workflow to ${entityId}`,
  };
}

// ── CLI Registration ───────────────────────────────────────────────

export function registerWorkflowCommand(program: Command): void {
  const wf = program
    .command("workflow")
    .description("Attach, show, validate, or run staged workflows on tasks/plans")
    .addHelpText(
      "after",
      `
A workflow is a staged sequence of Ix commands attached to a task, plan, or decision.
It is NOT a goal, plan, task, or bug — those are developer-cycle objects that may HAVE workflows.

Stages: discover, implement, validate

Subcommands:
  attach <type> <id>     Attach a workflow from a JSON file
  show <type> <id>       Show the workflow attached to a target
  validate <type> <id>   Validate workflow structure
  run <type> <id>        Execute workflow commands (ix-only, no shell)

Examples:
  ix workflow attach task <task-id> --file /path/to/workflow.json
  ix workflow attach plan <plan-id> --file /path/to/workflow.json
  ix workflow show task <task-id>
  ix workflow show plan <plan-id>
  ix workflow validate task <task-id>
  ix workflow run task <task-id> --stage discover
  ix workflow run plan <plan-id>`,
    );

  // ── attach ───────────────────────────────────────────────────────
  wf.command("attach <type> <id>")
    .description("Attach a workflow from a JSON file to a task, plan, or decision")
    .requiredOption("--file <path>", "Path to workflow JSON file")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (targetType: string, targetId: string, opts: { file: string; format: string }) => {
      const client = new IxClient(getEndpoint());

      // 1. Resolve target entity
      const details = await resolveTargetEntity(client, targetType, targetId);
      if (!details) return;

      // 2. Load and parse JSON file
      let raw: unknown;
      try {
        const content = fs.readFileSync(opts.file, "utf-8");
        raw = JSON.parse(content);
      } catch (err: any) {
        stderr(`Failed to read workflow file: ${err.message}`);
        process.exitCode = 1;
        return;
      }

      // 3. Validate workflow structure
      if (!isValidWorkflow(raw)) {
        stderr(`Invalid workflow structure in ${opts.file}.`);
        stderr(`Expected a flat array of strings or a staged object with keys: ${VALID_WORKFLOW_STAGES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const workflow = raw as string[] | StagedWorkflow;
      const normalized = normalizeWorkflow(workflow);

      // 4. Validate command safety
      const issues: string[] = [];
      for (const stage of VALID_WORKFLOW_STAGES) {
        const cmds = normalized[stage as keyof StagedWorkflow] ?? [];
        for (const cmd of cmds) {
          if (!cmd.trimStart().startsWith("ix ")) {
            issues.push(`Stage "${stage}": command does not start with "ix": ${cmd}`);
          }
          if (/[|;&`$()]/.test(cmd)) {
            issues.push(`Stage "${stage}": command contains shell operators: ${cmd}`);
          }
        }
      }
      if (issues.length > 0) {
        stderr("Workflow validation failed:");
        for (const issue of issues) {
          stderr(`  ${issue}`);
        }
        process.exitCode = 1;
        return;
      }

      // 5. Attach via patch
      const resolvedId = details.node.id ?? targetId;
      const patch = buildWorkflowAttachPatch(resolvedId, workflow);
      const result = await client.commitPatch(patch);
      const name = details.node.name || targetId;

      // 6. Read-after-write verification
      let verified: { node: any; claims: any[]; edges: any[] } | null = null;
      try {
        verified = await client.entity(resolvedId);
      } catch {
        stderr("Workflow patch committed but read-back failed. Entity may not exist.");
        process.exitCode = 1;
        return;
      }
      const verifiedWorkflow = extractWorkflow(verified.node, verified.claims);
      if (!verifiedWorkflow) {
        stderr("Workflow patch committed but read-back shows no workflow claim. Persistence may have failed.");
        process.exitCode = 1;
        return;
      }

      if (opts.format === "json") {
        console.log(JSON.stringify({
          targetType,
          targetId: resolvedId,
          targetName: name,
          attached: true,
          verified: true,
          workflow: verifiedWorkflow,
          rev: result.rev,
        }, null, 2));
      } else {
        console.log(`Workflow attached to ${chalk.cyan(targetType)} ${chalk.bold(name)} (rev ${result.rev})`);
        console.log(chalk.green("  Read-after-write verified."));
        for (const stage of VALID_WORKFLOW_STAGES) {
          const cmds = verifiedWorkflow[stage as keyof StagedWorkflow];
          if (cmds && cmds.length > 0) {
            console.log(`  ${chalk.bold(stage)}: ${cmds.length} command(s)`);
          }
        }
      }
    });

  // ── show ─────────────────────────────────────────────────────────
  wf.command("show <type> <id>")
    .description("Show the workflow attached to a task, plan, or decision")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (targetType: string, targetId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const details = await resolveTargetEntity(client, targetType, targetId);
      if (!details) return;

      const workflow = extractWorkflow(details.node, details.claims);
      const name = details.node.name || targetId;

      if (opts.format === "json") {
        console.log(JSON.stringify({
          targetType,
          targetId: details.node.id ?? targetId,
          targetName: name,
          workflow: workflow ?? null,
          hasWorkflow: !!workflow,
        }, null, 2));
      } else {
        console.log(`${chalk.bold(name)} (${chalk.cyan(targetType)})`);
        if (!workflow) {
          console.log(chalk.dim("  No workflow attached."));
          return;
        }
        for (const stage of VALID_WORKFLOW_STAGES) {
          const cmds = workflow[stage as keyof StagedWorkflow];
          if (cmds && cmds.length > 0) {
            console.log(`  ${chalk.bold(stage)}:`);
            for (const cmd of cmds) {
              console.log(`    ${chalk.cyan("▸")} ${cmd}`);
            }
          }
        }
      }
    });

  // ── validate ─────────────────────────────────────────────────────
  wf.command("validate <type> <id>")
    .description("Validate the workflow structure on a task, plan, or decision")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (targetType: string, targetId: string, opts: { format: string }) => {
      const client = new IxClient(getEndpoint());
      const details = await resolveTargetEntity(client, targetType, targetId);
      if (!details) return;

      const name = details.node.name || targetId;
      // Check claims first (for attached workflows), then attrs (for inline workflows)
      const workflowClaim = details.claims?.find(
        (c: any) => c.field === "workflow" || c.statement === "workflow"
      );
      const raw = workflowClaim ? (workflowClaim as any).value : details.node.attrs?.workflow;
      const issues: string[] = [];

      if (!raw) {
        issues.push("No workflow field present on entity.");
      } else if (Array.isArray(raw)) {
        // Legacy flat list — valid but could be normalized
        if (!raw.every((s: unknown) => typeof s === "string")) {
          issues.push("Legacy flat-list workflow contains non-string entries.");
        }
      } else if (typeof raw === "object" && raw !== null) {
        const keys = Object.keys(raw);
        for (const k of keys) {
          if (!VALID_WORKFLOW_STAGES.includes(k)) {
            issues.push(`Unknown stage key: "${k}". Valid: ${VALID_WORKFLOW_STAGES.join(", ")}`);
          }
        }
        for (const k of keys) {
          const val = (raw as any)[k];
          if (!Array.isArray(val)) {
            issues.push(`Stage "${k}" must be an array of strings, got ${typeof val}.`);
          } else if (!val.every((s: unknown) => typeof s === "string")) {
            issues.push(`Stage "${k}" contains non-string entries.`);
          }
        }
      } else {
        issues.push(`Workflow field is not an array or object (got ${typeof raw}).`);
      }

      // Check command safety
      if (raw && isValidWorkflow(raw)) {
        const normalized = normalizeWorkflow(raw as string[] | StagedWorkflow);
        for (const stage of VALID_WORKFLOW_STAGES) {
          const cmds = normalized[stage as keyof StagedWorkflow] ?? [];
          for (const cmd of cmds) {
            if (!cmd.trimStart().startsWith("ix ")) {
              issues.push(`Stage "${stage}": command does not start with "ix": ${cmd}`);
            }
            if (/[|;&`$()]/.test(cmd)) {
              issues.push(`Stage "${stage}": command contains shell operators: ${cmd}`);
            }
          }
        }
      }

      const valid = issues.length === 0 && !!raw;

      if (opts.format === "json") {
        console.log(JSON.stringify({
          targetType,
          targetId: details.node.id ?? targetId,
          targetName: name,
          valid,
          issues,
          normalized: raw && isValidWorkflow(raw)
            ? normalizeWorkflow(raw as string[] | StagedWorkflow)
            : null,
        }, null, 2));
      } else {
        console.log(`${chalk.bold(name)} (${chalk.cyan(targetType)})`);
        if (valid) {
          console.log(chalk.green("  Workflow is valid."));
          const normalized = normalizeWorkflow(raw as string[] | StagedWorkflow);
          for (const stage of VALID_WORKFLOW_STAGES) {
            const cmds = normalized[stage as keyof StagedWorkflow];
            if (cmds && cmds.length > 0) {
              console.log(`  ${chalk.bold(stage)}: ${cmds.length} command(s)`);
            }
          }
        } else {
          console.log(chalk.red("  Workflow validation failed:"));
          for (const issue of issues) {
            console.log(`    ${chalk.yellow("!")} ${issue}`);
          }
        }
      }
    });

  // ── run ──────────────────────────────────────────────────────────
  wf.command("run <type> <id>")
    .description("Execute workflow commands (ix-only, no arbitrary shell)")
    .option("--stage <stage>", "Run only this stage (discover|implement|validate)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (targetType: string, targetId: string, opts: { stage?: string; format: string }) => {
      const client = new IxClient(getEndpoint());
      const details = await resolveTargetEntity(client, targetType, targetId);
      if (!details) return;

      const name = details.node.name || targetId;
      const workflow = extractWorkflow(details.node, details.claims);

      if (!workflow) {
        if (opts.format === "json") {
          console.log(JSON.stringify({
            targetType,
            targetId: details.node.id ?? targetId,
            targetName: name,
            stagesRun: [],
            results: [],
            diagnostics: ["No workflow attached to this entity."],
          }, null, 2));
        } else {
          stderr("No workflow attached to this entity.");
        }
        return;
      }

      // Determine which stages to run
      let stagesToRun = [...VALID_WORKFLOW_STAGES];
      if (opts.stage) {
        if (!VALID_WORKFLOW_STAGES.includes(opts.stage)) {
          stderr(`Invalid stage "${opts.stage}". Valid: ${VALID_WORKFLOW_STAGES.join(", ")}`);
          return;
        }
        stagesToRun = [opts.stage];
      }

      if (opts.format !== "json") {
        console.log(`${chalk.bold("Running workflow")} for ${chalk.cyan(targetType)} ${chalk.bold(name)}\n`);
      }

      const results = await runWorkflowStages(workflow, stagesToRun);

      if (opts.format === "json") {
        console.log(JSON.stringify({
          targetType,
          targetId: details.node.id ?? targetId,
          targetName: name,
          stagesRun: stagesToRun.filter(s => {
            const cmds = workflow[s as keyof StagedWorkflow];
            return cmds && cmds.length > 0;
          }),
          results,
          diagnostics: [],
        }, null, 2));
      } else {
        for (const r of results) {
          const statusIcon = r.status === "ok" ? chalk.green("✓")
            : r.status === "error" ? chalk.red("✗")
            : chalk.yellow("⊘");
          console.log(`  ${statusIcon} ${chalk.dim(`[${r.stage}]`)} ${r.command}`);
          if (r.status === "error" && r.error) {
            console.log(`    ${chalk.red(r.error)}`);
          }
          if (r.status === "ok" && r.output && typeof r.output === "object") {
            // Show a brief summary of the output
            const keys = Object.keys(r.output as object);
            console.log(`    ${chalk.dim(`→ ${keys.length} fields returned`)}`);
          }
        }
        const okCount = results.filter(r => r.status === "ok").length;
        const errCount = results.filter(r => r.status === "error").length;
        const skipCount = results.filter(r => r.status === "skipped").length;
        console.log(`\n${chalk.dim(`Done: ${okCount} ok, ${errCount} error, ${skipCount} skipped`)}`);
      }
    });
}
