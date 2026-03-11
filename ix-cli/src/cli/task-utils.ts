import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Types ───────────────────────────────────────────────────────────

export interface StagedWorkflow {
  discover?: string[];
  implement?: string[];
  validate?: string[];
}

export const VALID_WORKFLOW_STAGES = ["discover", "implement", "validate"];

export const VALID_STATUSES = ["pending", "in_progress", "blocked", "done", "abandoned"];

export const STATUS_ICONS: Record<string, string> = {
  pending: "\u25CB",
  in_progress: "\u25D0",
  blocked: "\u2716",
  done: "\u25CF",
  abandoned: "\u2298",
};

// ── Workflow type guards / normalizers ───────────────────────────────

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

// ── Unified status reader ───────────────────────────────────────────

/**
 * Read task status from entity detail.
 * Priority: claims (field==="status" OR statement includes "status") > attrs.status > "pending"
 * Validates against VALID_STATUSES before returning.
 */
export function getTaskStatus(entityDetail: { node: any; claims: any[]; edges: any[] }): string {
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

// ── Workflow extraction ─────────────────────────────────────────────

/**
 * Extract workflow from an entity, checking claims first (for post-attach updates),
 * then falling back to node.attrs (for inline workflows set at creation time).
 */
export function extractWorkflow(node: any, claims?: any[]): StagedWorkflow | null {
  // Claims take precedence (workflow set via AssertClaim, e.g. workflow attach)
  if (claims) {
    const workflowClaim = claims.find(
      (c: any) => c.field === "workflow" || c.statement === "workflow"
    );
    if (workflowClaim) {
      const val = (workflowClaim as any).value;
      if (val && isValidWorkflow(val)) {
        return normalizeWorkflow(val as string[] | StagedWorkflow);
      }
    }
  }
  // Fall back to node attrs (workflow set at creation time)
  const raw = node.attrs?.workflow;
  if (!raw) return null;
  if (!isValidWorkflow(raw)) return null;
  return normalizeWorkflow(raw as string[] | StagedWorkflow);
}

// ── Workflow stage state ────────────────────────────────────────────

export type WorkflowStageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkflowState {
  discover?: WorkflowStageStatus;
  implement?: WorkflowStageStatus;
  validate?: WorkflowStageStatus;
}

const VALID_STAGE_STATUSES: WorkflowStageStatus[] = ["pending", "running", "done", "failed", "skipped"];

/**
 * Read workflow stage state from entity detail.
 * Reads claim with field "workflow_state", falls back to attrs.workflow_state.
 */
export function getWorkflowState(entityDetail: { node: any; claims: any[] }): WorkflowState | null {
  // Check claims first
  const stateClaim = entityDetail.claims?.find(
    (c: any) => c.field === "workflow_state"
  );
  if (stateClaim) {
    const val = (stateClaim as any).value;
    if (val && typeof val === "object" && !Array.isArray(val)) {
      // Validate stage statuses
      const result: WorkflowState = {};
      for (const stage of VALID_WORKFLOW_STAGES) {
        const sv = (val as any)[stage];
        if (typeof sv === "string" && VALID_STAGE_STATUSES.includes(sv as WorkflowStageStatus)) {
          (result as any)[stage] = sv;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    }
  }
  // Fall back to attrs
  const attrState = entityDetail.node?.attrs?.workflow_state;
  if (attrState && typeof attrState === "object" && !Array.isArray(attrState)) {
    const result: WorkflowState = {};
    for (const stage of VALID_WORKFLOW_STAGES) {
      const sv = (attrState as any)[stage];
      if (typeof sv === "string" && VALID_STAGE_STATUSES.includes(sv as WorkflowStageStatus)) {
        (result as any)[stage] = sv;
      }
    }
    return Object.keys(result).length > 0 ? result : null;
  }
  return null;
}

// ── Workflow execution ──────────────────────────────────────────────

export interface WorkflowRunResult {
  stage: string;
  command: string;
  status: "ok" | "error" | "skipped";
  output?: unknown;
  error?: string;
}

export async function executeIxCommand(cmd: string): Promise<unknown> {
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

export async function runWorkflowStages(
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

// ── Workflow stage state display ────────────────────────────────────

const STAGE_STATUS_ICONS: Record<WorkflowStageStatus, string> = {
  pending: "\u25CB",
  running: "\u2026",
  done: "\u2713",
  failed: "\u2717",
  skipped: "\u2298",
};

export function formatWorkflowStateCompact(state: WorkflowState): string {
  const parts: string[] = [];
  for (const stage of VALID_WORKFLOW_STAGES) {
    const s = (state as any)[stage] as WorkflowStageStatus | undefined;
    if (s) {
      const icon = STAGE_STATUS_ICONS[s] ?? "?";
      parts.push(`${stage}${icon}`);
    }
  }
  return parts.length > 0 ? `[${parts.join(" ")}]` : "";
}
