import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { getTaskStatus } from "../task-utils.js";

/**
 * Verify task status reading — unified getTaskStatus function + source integration.
 */

const planTsPath = path.resolve(__dirname, "../commands/plan.ts");
const planContent = fs.readFileSync(planTsPath, "utf-8");

const tasksTsPath = path.resolve(__dirname, "../commands/tasks.ts");
const tasksContent = fs.readFileSync(tasksTsPath, "utf-8");

// ── Unit tests for getTaskStatus ──────────────────────────────────

describe("getTaskStatus", () => {
  it("returns status from claim with field='status'", () => {
    const detail = {
      node: { attrs: { status: "pending" } },
      claims: [{ field: "status", value: "done" }],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("done");
  });

  it("returns status from claim with statement containing 'status'", () => {
    const detail = {
      node: { attrs: { status: "pending" } },
      claims: [{ statement: "task status update", value: "in_progress" }],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("in_progress");
  });

  it("falls back to attrs.status when no claims match", () => {
    const detail = {
      node: { attrs: { status: "blocked" } },
      claims: [{ field: "workflow", value: {} }],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("blocked");
  });

  it("falls back to attrs.status when claims array is empty", () => {
    const detail = {
      node: { attrs: { status: "in_progress" } },
      claims: [],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("in_progress");
  });

  it("returns 'pending' when no claims and no attrs.status", () => {
    const detail = {
      node: { attrs: {} },
      claims: [],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("pending");
  });

  it("ignores invalid claim values and falls back", () => {
    const detail = {
      node: { attrs: { status: "done" } },
      claims: [{ field: "status", value: "INVALID_STATUS" }],
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("done");
  });

  it("handles null claims gracefully", () => {
    const detail = {
      node: { attrs: { status: "abandoned" } },
      claims: null as any,
      edges: [],
    };
    expect(getTaskStatus(detail)).toBe("abandoned");
  });
});

// ── Source-reading: plan.ts and tasks.ts import getTaskStatus from task-utils ──

describe("plan.ts uses shared getTaskStatus", () => {
  it("imports getTaskStatus from task-utils", () => {
    expect(planContent).toContain("getTaskStatus");
    expect(planContent).toContain('from "../task-utils.js"');
  });

  it("does not have local getTaskStatus function", () => {
    // Should NOT have a local function definition
    expect(planContent).not.toMatch(/^function getTaskStatus/m);
  });

  it("has --run-workflow option on task update", () => {
    expect(planContent).toContain("--run-workflow");
  });

  it("has --status as optional (not requiredOption)", () => {
    // Should use .option not .requiredOption for --status
    expect(planContent).toContain('.option("--status <status>"');
  });

  it("validates at least one of --status or --run-workflow", () => {
    expect(planContent).toContain("!opts.status && !opts.runWorkflow");
  });
});

describe("tasks.ts uses shared getTaskStatus", () => {
  it("imports getTaskStatus from task-utils", () => {
    expect(tasksContent).toContain("getTaskStatus");
    expect(tasksContent).toContain('from "../task-utils.js"');
  });

  it("does not define local STATUS_ICONS", () => {
    expect(tasksContent).not.toMatch(/^const STATUS_ICONS/m);
  });

  it("imports STATUS_ICONS from task-utils", () => {
    expect(tasksContent).toContain("STATUS_ICONS");
  });

  it("uses Promise.all for parallel entity fetches", () => {
    expect(tasksContent).toContain("Promise.all(");
  });

  it("imports getWorkflowState", () => {
    expect(tasksContent).toContain("getWorkflowState");
  });
});
