import { describe, it, expect } from "vitest";
import { buildDecisionPatch } from "../commands/decide.js";

describe("buildDecisionPatch", () => {
  it("creates a patch with DECISION_AFFECTS edges", () => {
    const patch = buildDecisionPatch(
      "Use client-side patch",
      "Avoid server coupling",
      {
        affects: [
          { id: "entity-1", kind: "class", name: "IngestionService" },
          { id: "entity-2", kind: "class", name: "IxClient" },
        ],
      }
    );
    expect(patch.ops.length).toBe(3); // 1 UpsertNode + 2 UpsertEdge
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("decision");
    expect(patch.ops[1].type).toBe("UpsertEdge");
    expect(patch.ops[1].predicate).toBe("DECISION_AFFECTS");
    expect(patch.ops[2].predicate).toBe("DECISION_AFFECTS");
  });

  it("creates DECISION_SUPERSEDES edge when supersedes is provided", () => {
    const patch = buildDecisionPatch("New approach", "Better", {
      supersedes: "old-decision-id",
    });
    expect(patch.ops.length).toBe(2); // 1 UpsertNode + 1 UpsertEdge
    expect(patch.ops[1].predicate).toBe("DECISION_SUPERSEDES");
    expect(patch.ops[1].src).toBe(patch.ops[0].id); // new decision → old
    expect(patch.ops[1].dst).toBe("old-decision-id");
  });

  it("creates DECISION_CHILD edge when parent is provided", () => {
    const patch = buildDecisionPatch("Sub-decision", "Detail", {
      parent: "parent-decision-id",
    });
    expect(patch.ops.length).toBe(2);
    expect(patch.ops[1].predicate).toBe("DECISION_CHILD");
    expect(patch.ops[1].src).toBe("parent-decision-id"); // parent → child
    expect(patch.ops[1].dst).toBe(patch.ops[0].id);
  });
});
