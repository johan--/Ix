import { describe, it, expect } from "vitest";
import { buildBugPatch, buildBugUpdatePatch } from "../commands/bug.js";

describe("buildBugPatch", () => {
  it("creates a Bug node with correct kind and attrs", () => {
    const patch = buildBugPatch("Login fails", "Users cannot log in", "high");
    expect(patch.ops[0].type).toBe("UpsertNode");
    expect(patch.ops[0].kind).toBe("bug");
    expect(patch.ops[0].name).toBe("Login fails");
    const attrs = patch.ops[0].attrs as Record<string, unknown>;
    expect(attrs.description).toBe("Users cannot log in");
    expect(attrs.status).toBe("open");
    expect(attrs.severity).toBe("high");
    expect(attrs.created_at).toBeDefined();
  });

  it("defaults severity to medium", () => {
    const patch = buildBugPatch("Minor issue", "Something small");
    const attrs = patch.ops[0].attrs as Record<string, unknown>;
    expect(attrs.severity).toBe("medium");
  });

  it("creates BUG_AFFECTS edges when affects provided", () => {
    const patch = buildBugPatch("Crash bug", "Crashes on load", "critical", {
      affects: [
        { id: "entity-1", kind: "class", name: "AuthService" },
        { id: "entity-2", kind: "function", name: "verifyToken" },
      ],
    });
    expect(patch.ops.length).toBe(3); // 1 UpsertNode + 2 UpsertEdge
    expect(patch.ops[1].type).toBe("UpsertEdge");
    expect(patch.ops[1].predicate).toBe("BUG_AFFECTS");
    expect(patch.ops[1].src).toBe(patch.ops[0].id);
    expect(patch.ops[1].dst).toBe("entity-1");
    expect(patch.ops[2].predicate).toBe("BUG_AFFECTS");
    expect(patch.ops[2].dst).toBe("entity-2");
  });

  it("creates no edges when affects is empty", () => {
    const patch = buildBugPatch("Standalone bug", "No links");
    expect(patch.ops.length).toBe(1);
  });

  it("uses sourceType cli", () => {
    const patch = buildBugPatch("Test bug", "desc");
    expect(patch.source.sourceType).toBe("cli");
  });
});

describe("buildBugUpdatePatch", () => {
  it("creates an AssertClaim for status change", () => {
    const patch = buildBugUpdatePatch("bug-id-123", "investigating");
    expect(patch.ops.length).toBe(1);
    expect(patch.ops[0].type).toBe("AssertClaim");
    expect(patch.ops[0].field).toBe("status");
    expect(patch.ops[0].value).toBe("investigating");
  });

  it("uses sourceType cli", () => {
    const patch = buildBugUpdatePatch("bug-id-123", "resolved");
    expect(patch.source.sourceType).toBe("cli");
  });
});
