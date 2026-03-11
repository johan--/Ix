import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWorkflowState, formatWorkflowStateCompact } from "../task-utils.js";

/**
 * Verify workflow stage state tracking.
 */

const planTsPath = path.resolve(__dirname, "../commands/plan.ts");
const planContent = fs.readFileSync(planTsPath, "utf-8");

const tasksTsPath = path.resolve(__dirname, "../commands/tasks.ts");
const tasksContent = fs.readFileSync(tasksTsPath, "utf-8");

// ── Unit tests for getWorkflowState ────────────────────────────────

describe("getWorkflowState", () => {
  it("returns workflow state from claim with field='workflow_state'", () => {
    const detail = {
      node: { attrs: {} },
      claims: [{ field: "workflow_state", value: { discover: "done", implement: "running" } }],
    };
    const result = getWorkflowState(detail);
    expect(result).toEqual({ discover: "done", implement: "running" });
  });

  it("falls back to attrs.workflow_state when no claims", () => {
    const detail = {
      node: { attrs: { workflow_state: { discover: "done", validate: "pending" } } },
      claims: [],
    };
    const result = getWorkflowState(detail);
    expect(result).toEqual({ discover: "done", validate: "pending" });
  });

  it("returns null when neither claims nor attrs have workflow_state", () => {
    const detail = {
      node: { attrs: {} },
      claims: [],
    };
    expect(getWorkflowState(detail)).toBeNull();
  });

  it("validates stage status values", () => {
    const detail = {
      node: { attrs: {} },
      claims: [{ field: "workflow_state", value: { discover: "INVALID", implement: "done" } }],
    };
    const result = getWorkflowState(detail);
    // Only valid stage statuses are included
    expect(result).toEqual({ implement: "done" });
  });

  it("returns null for empty valid result", () => {
    const detail = {
      node: { attrs: {} },
      claims: [{ field: "workflow_state", value: { discover: "INVALID" } }],
    };
    expect(getWorkflowState(detail)).toBeNull();
  });

  it("handles all valid stage statuses", () => {
    const detail = {
      node: { attrs: {} },
      claims: [{ field: "workflow_state", value: {
        discover: "done",
        implement: "running",
        validate: "pending",
      } }],
    };
    const result = getWorkflowState(detail);
    expect(result).toEqual({ discover: "done", implement: "running", validate: "pending" });
  });

  it("handles 'failed' and 'skipped' statuses", () => {
    const detail = {
      node: { attrs: {} },
      claims: [{ field: "workflow_state", value: {
        discover: "failed",
        implement: "skipped",
      } }],
    };
    const result = getWorkflowState(detail);
    expect(result).toEqual({ discover: "failed", implement: "skipped" });
  });
});

// ── Source-reading: plan.ts has buildWorkflowStatePatch ──────────────

describe("plan.ts workflow state integration", () => {
  it("has buildWorkflowStatePatch with field 'workflow_state'", () => {
    expect(planContent).toContain("buildWorkflowStatePatch");
    expect(planContent).toContain('field: "workflow_state"');
  });

  it("task show includes workflowState in JSON", () => {
    expect(planContent).toContain("workflowState");
  });

  it("imports getWorkflowState from task-utils", () => {
    expect(planContent).toContain("getWorkflowState");
  });
});

describe("tasks.ts workflow state integration", () => {
  it("imports getWorkflowState from task-utils", () => {
    expect(tasksContent).toContain("getWorkflowState");
    expect(tasksContent).toContain('from "../task-utils.js"');
  });
});

// ── Unit tests for formatWorkflowStateCompact ───────────────────────

describe("formatWorkflowStateCompact", () => {
  it("formats all three stages", () => {
    const result = formatWorkflowStateCompact({
      discover: "done",
      implement: "running",
      validate: "pending",
    });
    // Format: [discover✓ implement… validate○]
    expect(result).toContain("discover");
    expect(result).toContain("implement");
    expect(result).toContain("validate");
    expect(result).toMatch(/^\[.*\]$/);
  });

  it("formats single stage", () => {
    const result = formatWorkflowStateCompact({ discover: "done" });
    expect(result).toContain("discover");
    expect(result).not.toContain("implement");
  });

  it("returns empty string for empty state", () => {
    const result = formatWorkflowStateCompact({});
    expect(result).toBe("");
  });

  it("uses stage name directly (not abbreviation)", () => {
    const result = formatWorkflowStateCompact({ discover: "done" });
    // Should contain full stage name, not just "D:"
    expect(result).toContain("discover");
    expect(result).not.toContain("D:");
  });

  it("uses … icon for running stage", () => {
    const result = formatWorkflowStateCompact({ implement: "running" });
    expect(result).toContain("\u2026"); // ellipsis
  });

  it("uses ✓ icon for done stage", () => {
    const result = formatWorkflowStateCompact({ discover: "done" });
    expect(result).toContain("\u2713"); // check mark
  });
});
