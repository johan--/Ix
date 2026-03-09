import { describe, it, expect } from "vitest";
import { buildPlanPatch, buildTaskPatch, buildTaskUpdatePatch } from "../commands/plan.js";

describe("buildPlanPatch", () => {
  it("creates a Plan node and GOAL_HAS_PLAN edge", () => {
    const patch = buildPlanPatch("GitHub Ingestion", "goal-id-123");
    expect(patch.ops.length).toBe(2);
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("plan");
    expect(patch.ops[0].name).toBe("GitHub Ingestion");
    expect(patch.ops[1].type).toBe("UpsertEdge");
    expect(patch.ops[1].predicate).toBe("GOAL_HAS_PLAN");
    expect(patch.ops[1].src).toBe("goal-id-123");
    expect(patch.ops[1].dst).toBe(patch.ops[0].id);
  });

  it("adds RESPONDS_TO edge when respondsTo is provided", () => {
    const patch = buildPlanPatch("Fix plan", "goal-id-123", "bug-id-456");
    expect(patch.ops.length).toBe(3); // node + GOAL_HAS_PLAN + RESPONDS_TO
    expect(patch.ops[2].type).toBe("UpsertEdge");
    expect(patch.ops[2].predicate).toBe("RESPONDS_TO");
    expect(patch.ops[2].src).toBe(patch.ops[0].id); // plan → bug
    expect(patch.ops[2].dst).toBe("bug-id-456");
  });

  it("omits RESPONDS_TO edge when respondsTo is not provided", () => {
    const patch = buildPlanPatch("Simple plan", "goal-id-123");
    expect(patch.ops.length).toBe(2);
  });

  it("uses sourceType cli", () => {
    const patch = buildPlanPatch("Plan", "goal-id");
    expect(patch.source.sourceType).toBe("cli");
  });
});

describe("buildTaskPatch", () => {
  it("creates a Task node and PLAN_HAS_TASK edge", () => {
    const patch = buildTaskPatch("Fetch GitHub API", { planId: "plan-123" });
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("task");
    expect((patch.ops[0].attrs as Record<string, unknown>).status).toBe("pending");
    expect(patch.ops[1].predicate).toBe("PLAN_HAS_TASK");
  });

  it("adds DEPENDS_ON edge when dependsOn is provided", () => {
    const patch = buildTaskPatch("Transform layer", {
      planId: "plan-123",
      dependsOn: "task-abc",
    });
    expect(patch.ops.length).toBe(3); // node + PLAN_HAS_TASK + DEPENDS_ON
    expect(patch.ops[2].predicate).toBe("DEPENDS_ON");
    expect(patch.ops[2].src).toBe(patch.ops[0].id); // this task depends on...
    expect(patch.ops[2].dst).toBe("task-abc");
  });

  it("adds TASK_AFFECTS edges when affects is provided", () => {
    const patch = buildTaskPatch("Wire up service", {
      planId: "plan-123",
      affects: [
        { id: "entity-1", kind: "class", name: "IngestionService" },
      ],
    });
    expect(patch.ops.length).toBe(3); // node + PLAN_HAS_TASK + TASK_AFFECTS
    expect(patch.ops[2].predicate).toBe("TASK_AFFECTS");
  });

  it("uses sourceType cli", () => {
    const patch = buildTaskPatch("Task", { planId: "plan-123" });
    expect(patch.source.sourceType).toBe("cli");
  });
});

describe("buildTaskUpdatePatch", () => {
  it("creates an AssertClaim for status change", () => {
    const patch = buildTaskUpdatePatch("task-id-123", "done");
    expect(patch.ops.length).toBe(1);
    expect(patch.ops[0].type).toBe("AssertClaim");
    expect(patch.ops[0].field).toBe("status");
    expect(patch.ops[0].value).toBe("done");
  });

  it("uses sourceType cli", () => {
    const patch = buildTaskUpdatePatch("task-id-123", "done");
    expect(patch.source.sourceType).toBe("cli");
  });
});
