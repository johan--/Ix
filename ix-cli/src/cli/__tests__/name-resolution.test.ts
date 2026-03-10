import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Verify name-based resolution, duplicate prevention, read-after-write,
 * and new subcommands (goal show, plan show).
 */

const planTsPath = path.resolve(__dirname, "../commands/plan.ts");
const planContent = fs.readFileSync(planTsPath, "utf-8");

const goalTsPath = path.resolve(__dirname, "../commands/goal.ts");
const goalContent = fs.readFileSync(goalTsPath, "utf-8");

const workflowTsPath = path.resolve(__dirname, "../commands/workflow.ts");
const workflowContent = fs.readFileSync(workflowTsPath, "utf-8");

const mainTsPath = path.resolve(__dirname, "../main.ts");
const mainContent = fs.readFileSync(mainTsPath, "utf-8");

// ── Name-based resolution for --goal and --plan ──────────────────────

describe("plan create --goal accepts name", () => {
  it("plan create resolves --goal via resolvePrefix then listTruth", () => {
    expect(planContent).toContain("client.resolvePrefix(opts.goal)");
    expect(planContent).toContain("client.listTruth()");
  });

  it("plan create --goal option says id-or-name", () => {
    expect(planContent).toContain("--goal <id-or-name>");
  });

  it("plan create checks duplicate plan name before creating", () => {
    expect(planContent).toContain('kind: "plan", nameOnly: true');
    expect(planContent).toContain("already exists");
  });

  it("plan create falls back to goal name search when prefix fails", () => {
    // Should search listTruth and find by name
    expect(planContent).toContain("opts.goal.toLowerCase()");
  });
});

describe("plan task --plan accepts name", () => {
  it("plan task resolves --plan via resolvePrefix then resolveEntity", () => {
    expect(planContent).toContain("client.resolvePrefix(opts.plan)");
    expect(planContent).toContain('resolveEntity(client, opts.plan, ["plan"]');
  });

  it("plan task --plan option says id-or-name", () => {
    expect(planContent).toContain("--plan <id-or-name>");
  });

  it("plan task checks duplicate task name within plan", () => {
    expect(planContent).toContain("PLAN_HAS_TASK");
    expect(planContent).toContain("already exists in this plan");
  });
});

// ── Plan show alias ──────────────────────────────────────────────────

describe("plan show alias", () => {
  it("plan status has show alias", () => {
    expect(planContent).toContain('.alias("show")');
  });

  it("help text mentions show alias", () => {
    expect(planContent).toContain("alias: show");
  });
});

// ── Goal show command ────────────────────────────────────────────────

describe("goal show command", () => {
  it("goal.ts registers show subcommand", () => {
    expect(goalContent).toContain('command("show <ref>")');
  });

  it("goal show resolves by name via listTruth", () => {
    expect(goalContent).toContain("client.resolvePrefix(ref)");
    expect(goalContent).toContain("client.listTruth()");
  });

  it("goal show fetches entity details", () => {
    expect(goalContent).toContain("client.entity(goalId)");
  });

  it("goal show expands GOAL_HAS_PLAN for linked plans", () => {
    expect(goalContent).toContain("GOAL_HAS_PLAN");
  });

  it("goal show supports --format json", () => {
    expect(goalContent).toContain("--format");
  });

  it("goal help text mentions show subcommand", () => {
    expect(goalContent).toContain("show <ref>");
  });
});

// ── Goal create duplicate prevention ─────────────────────────────────

describe("goal create duplicate prevention", () => {
  it("goal create checks for existing goal with same name", () => {
    expect(goalContent).toContain("client.listTruth()");
    expect(goalContent).toContain("statement.toLowerCase()");
  });

  it("goal create rejects duplicate with error message", () => {
    expect(goalContent).toContain("already exists");
  });

  it("goal help text mentions duplicate rejection", () => {
    expect(goalContent).toContain("rejects duplicate");
  });
});

// ── Workflow attach read-after-write ─────────────────────────────────

describe("workflow attach read-after-write", () => {
  it("workflow attach re-fetches entity after commitPatch", () => {
    // After commitPatch, should call client.entity to verify
    expect(workflowContent).toContain("client.entity(resolvedId)");
  });

  it("workflow attach calls extractWorkflow on verified entity", () => {
    expect(workflowContent).toContain("extractWorkflow(verified.node, verified.claims)");
  });

  it("workflow attach fails if verified workflow is null", () => {
    expect(workflowContent).toContain("no workflow claim");
  });

  it("workflow attach JSON output includes verified flag", () => {
    expect(workflowContent).toContain("verified: true");
  });

  it("workflow attach text output confirms read-after-write", () => {
    expect(workflowContent).toContain("Read-after-write verified");
  });
});

// ── Help text updates ────────────────────────────────────────────────

describe("help text updates", () => {
  it("plan help mentions id-or-name for --goal", () => {
    expect(planContent).toContain("goal-id-or-name");
  });

  it("plan help mentions id-or-name for --plan", () => {
    expect(planContent).toContain("plan-id-or-name");
  });

  it("plan help mentions plan show in examples", () => {
    expect(planContent).toContain("ix plan show");
  });

  it("goal help mentions goal show in examples", () => {
    expect(goalContent).toContain("ix goal show");
  });
});
