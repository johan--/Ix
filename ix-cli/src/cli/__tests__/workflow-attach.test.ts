import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildWorkflowAttachPatch, extractWorkflow } from "../commands/workflow.js";
import { isValidWorkflow, normalizeWorkflow } from "../commands/plan.js";

const workflowTsPath = path.resolve(__dirname, "../commands/workflow.ts");
const workflowContent = fs.readFileSync(workflowTsPath, "utf-8");

const goalTsPath = path.resolve(__dirname, "../commands/goal.ts");
const goalContent = fs.readFileSync(goalTsPath, "utf-8");

const mainTsPath = path.resolve(__dirname, "../main.ts");
const mainContent = fs.readFileSync(mainTsPath, "utf-8");

const goalsTsPath = path.resolve(__dirname, "../commands/goals.ts");
const goalsContent = fs.readFileSync(goalsTsPath, "utf-8");

const workflowsHelpPath = path.resolve(__dirname, "../commands/workflows.ts");
const workflowsHelpContent = fs.readFileSync(workflowsHelpPath, "utf-8");

describe("buildWorkflowAttachPatch", () => {
  it("creates an AssertClaim for workflow field", () => {
    const workflow = { discover: ["ix overview Auth"], implement: ["ix read Auth"] };
    const patch = buildWorkflowAttachPatch("entity-123", workflow);
    expect(patch.ops.length).toBe(1);
    expect(patch.ops[0].type).toBe("AssertClaim");
    expect(patch.ops[0].field).toBe("workflow");
    expect(patch.ops[0].value).toEqual(workflow);
    expect(patch.ops[0].confidence).toBe(1.0);
  });

  it("uses sourceType cli", () => {
    const patch = buildWorkflowAttachPatch("entity-123", ["ix overview X"]);
    expect(patch.source.sourceType).toBe("cli");
  });

  it("works with flat array workflow", () => {
    const workflow = ["ix overview Auth", "ix read Auth"];
    const patch = buildWorkflowAttachPatch("entity-123", workflow);
    expect(patch.ops[0].value).toEqual(workflow);
  });

  it("works with staged workflow", () => {
    const workflow = { discover: ["ix overview X"], validate: ["ix callers X"] };
    const patch = buildWorkflowAttachPatch("entity-123", workflow);
    expect(patch.ops[0].value).toEqual(workflow);
  });
});

describe("workflow attach subcommand registration", () => {
  it("workflow.ts registers attach subcommand", () => {
    expect(workflowContent).toContain('command("attach <type> <id>")');
  });

  it("workflow.ts attach requires --file option", () => {
    expect(workflowContent).toContain("--file");
  });

  it("workflow.ts attach validates workflow before attaching", () => {
    expect(workflowContent).toContain("isValidWorkflow");
  });

  it("workflow.ts attach calls commitPatch", () => {
    expect(workflowContent).toContain("commitPatch");
  });

  it("workflow.ts help text mentions attach", () => {
    expect(workflowContent).toContain("attach <type> <id>");
  });
});

describe("ix goals alias", () => {
  it("goals.ts exists and exports registerGoalsCommand", () => {
    expect(goalsContent).toContain("export function registerGoalsCommand");
  });

  it("goals.ts registers 'goals' command", () => {
    expect(goalsContent).toContain('command("goals")');
  });

  it("goals.ts supports --status filter", () => {
    expect(goalsContent).toContain("--status");
  });

  it("goals.ts supports --format option", () => {
    expect(goalsContent).toContain("--format");
  });

  it("main.ts imports and registers goals command", () => {
    expect(mainContent).toContain("registerGoalsCommand");
  });
});

describe("help discoverability", () => {
  it("main.ts HELP_HEADER includes goals", () => {
    const headerMatch = mainContent.match(/const HELP_HEADER = `([\s\S]*?)`;/);
    const header = headerMatch?.[1] ?? "";
    expect(header).toContain("goals");
  });

  it("main.ts HELP_HEADER workflow description mentions attach", () => {
    const headerMatch = mainContent.match(/const HELP_HEADER = `([\s\S]*?)`;/);
    const header = headerMatch?.[1] ?? "";
    expect(header).toContain("Attach");
  });

  it("workflows help mentions workflow attach", () => {
    expect(workflowsHelpContent).toContain("workflow attach");
  });

  it("goal help text mentions ix goals shorthand", () => {
    expect(goalContent).toContain("ix goals");
  });
});

describe("workflow validation with isValidWorkflow", () => {
  it("accepts staged object with all valid stages", () => {
    expect(isValidWorkflow({ discover: ["a"], implement: ["b"], validate: ["c"] })).toBe(true);
  });

  it("accepts staged object with subset of stages", () => {
    expect(isValidWorkflow({ discover: ["a"] })).toBe(true);
  });

  it("normalizes flat array to discover stage", () => {
    const result = normalizeWorkflow(["ix overview X"]);
    expect(result.discover).toEqual(["ix overview X"]);
  });
});

describe("extractWorkflow claims integration", () => {
  it("returns workflow from node.attrs when no claims", () => {
    const node = { attrs: { workflow: { discover: ["ix overview X"] } } };
    const result = extractWorkflow(node);
    expect(result).toEqual({ discover: ["ix overview X"] });
  });

  it("returns workflow from claims when present (field key)", () => {
    const node = { attrs: {} };
    const claims = [{ field: "workflow", value: { discover: ["ix read Y"] } }];
    const result = extractWorkflow(node, claims);
    expect(result).toEqual({ discover: ["ix read Y"] });
  });

  it("returns workflow from claims when present (statement key)", () => {
    const node = { attrs: {} };
    const claims = [{ statement: "workflow", value: { discover: ["ix read Y"] } }];
    const result = extractWorkflow(node, claims);
    expect(result).toEqual({ discover: ["ix read Y"] });
  });

  it("claims take precedence over attrs", () => {
    const node = { attrs: { workflow: { discover: ["ix overview OLD"] } } };
    const claims = [{ statement: "workflow", value: { discover: ["ix overview NEW"] } }];
    const result = extractWorkflow(node, claims);
    expect(result).toEqual({ discover: ["ix overview NEW"] });
  });

  it("falls back to attrs when claims have no workflow", () => {
    const node = { attrs: { workflow: ["ix overview X"] } };
    const claims = [{ field: "status", value: "done" }];
    const result = extractWorkflow(node, claims);
    expect(result).toEqual({ discover: ["ix overview X"] });
  });

  it("returns null when neither claims nor attrs have workflow", () => {
    const node = { attrs: {} };
    const claims: any[] = [];
    const result = extractWorkflow(node, claims);
    expect(result).toBeNull();
  });

  it("normalizes flat array from claims to discover", () => {
    const node = { attrs: {} };
    const claims = [{ statement: "workflow", value: ["ix overview Z"] }];
    const result = extractWorkflow(node, claims);
    expect(result).toEqual({ discover: ["ix overview Z"] });
  });
});

describe("plan.ts workflow retrieval checks claims", () => {
  const planTsPath = path.resolve(__dirname, "../commands/plan.ts");
  const planContent = fs.readFileSync(planTsPath, "utf-8");

  it("task show checks claims for workflow", () => {
    // Should check both field and statement keys for claim matching
    expect(planContent).toContain('c.field === "workflow" || c.statement === "workflow"');
  });

  it("plan next checks claims for workflow", () => {
    // Should have two occurrences of workflow claim checking (task show + plan next)
    const matches = planContent.match(/c\.field === "workflow" \|\| c\.statement === "workflow"/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});
