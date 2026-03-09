import { describe, it, expect, vi } from "vitest";
import { buildBriefing, type BriefingResult } from "../commands/briefing.js";

function mockClient(overrides: Partial<Record<string, any>> = {}): any {
  return {
    health: vi.fn().mockResolvedValue({ status: "ok" }),
    listByKind: vi.fn().mockImplementation((kind: string) => {
      if (overrides[`listByKind:${kind}`]) return Promise.resolve(overrides[`listByKind:${kind}`]);
      return Promise.resolve([]);
    }),
    listDecisions: vi.fn().mockResolvedValue(overrides.decisions ?? []),
    listPatches: vi.fn().mockResolvedValue(overrides.patches ?? []),
    conflicts: vi.fn().mockResolvedValue(overrides.conflicts ?? []),
    expand: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    entity: vi.fn().mockResolvedValue({ node: { attrs: {} }, claims: [], edges: [] }),
    ...overrides.clientOverrides,
  };
}

describe("buildBriefing", () => {
  it("returns all expected top-level keys", async () => {
    const client = mockClient();
    const result = await buildBriefing(client);
    expect(result).toHaveProperty("lastIngestAt");
    expect(result).toHaveProperty("revision");
    expect(result).toHaveProperty("activeGoals");
    expect(result).toHaveProperty("activePlans");
    expect(result).toHaveProperty("openBugs");
    expect(result).toHaveProperty("recentDecisions");
    expect(result).toHaveProperty("recentChanges");
    expect(result).toHaveProperty("conflicts");
    expect(result).toHaveProperty("diagnostics");
  });

  it("produces valid output with empty state (no crashes)", async () => {
    const client = mockClient();
    const result = await buildBriefing(client);
    expect(result.activeGoals).toEqual([]);
    expect(result.activePlans).toEqual([]);
    expect(result.openBugs).toEqual([]);
    expect(result.recentDecisions).toEqual([]);
    expect(result.recentChanges).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.lastIngestAt).toBeNull();
    expect(result.revision).toBeNull();
  });

  it("maps goals from intent nodes", async () => {
    const client = mockClient({
      "listByKind:intent": [
        { id: "g1", name: "Support GitHub", attrs: {} },
        { id: "g2", name: "Scale to 100k", attrs: {} },
      ],
    });
    const result = await buildBriefing(client);
    expect(result.activeGoals).toHaveLength(2);
    expect(result.activeGoals[0]).toEqual({ id: "g1", name: "Support GitHub" });
    expect(result.activeGoals[1]).toEqual({ id: "g2", name: "Scale to 100k" });
  });

  it("filters bugs to open/investigating only", async () => {
    const client = mockClient({
      "listByKind:bug": [
        { id: "b1", name: "Login crash", attrs: { status: "open", severity: "high" } },
        { id: "b2", name: "Fixed bug", attrs: { status: "resolved", severity: "low" } },
        { id: "b3", name: "Under review", attrs: { status: "investigating", severity: "medium" } },
      ],
    });
    const result = await buildBriefing(client);
    expect(result.openBugs).toHaveLength(2);
    expect(result.openBugs.map(b => b.id)).toEqual(["b1", "b3"]);
  });

  it("extracts revision and lastIngestAt from patches", async () => {
    const client = mockClient({
      patches: [
        { patch_id: "p1", rev: 42, intent: "Ingest src", timestamp: "2026-03-08T10:00:00Z" },
      ],
    });
    const result = await buildBriefing(client);
    expect(result.revision).toBe(42);
    expect(result.lastIngestAt).toBe("2026-03-08T10:00:00Z");
  });

  it("maps recent decisions", async () => {
    const client = mockClient({
      decisions: [
        { id: "d1", name: "Use CONTAINS", attrs: { rationale: "Normalize edges" } },
      ],
    });
    const result = await buildBriefing(client);
    expect(result.recentDecisions).toHaveLength(1);
    expect(result.recentDecisions[0].name).toBe("Use CONTAINS");
    expect(result.recentDecisions[0].rationale).toBe("Normalize edges");
  });

  it("includes plan task summary with nextTask", async () => {
    const planNode = { id: "plan-1", name: "Fix Auth", kind: "plan", attrs: {} };
    const taskNode = { id: "task-1", name: "Update token", kind: "task", attrs: { status: "pending" } };

    const client = mockClient({
      "listByKind:plan": [planNode],
      clientOverrides: {
        expand: vi.fn().mockImplementation((id: string, opts: any) => {
          if (id === "plan-1" && opts.predicates?.includes("PLAN_HAS_TASK")) {
            return Promise.resolve({ nodes: [taskNode], edges: [] });
          }
          return Promise.resolve({ nodes: [], edges: [] });
        }),
        entity: vi.fn().mockResolvedValue({
          node: { attrs: { status: "pending" } },
          claims: [],
          edges: [],
        }),
      },
    });

    const result = await buildBriefing(client);
    expect(result.activePlans).toHaveLength(1);
    expect(result.activePlans[0].name).toBe("Fix Auth");
    expect(result.activePlans[0].taskSummary.total).toBe(1);
    expect(result.activePlans[0].taskSummary.pending).toBe(1);
    expect(result.activePlans[0].nextTask).toBe("Update token");
  });

  it("records diagnostics when endpoints fail", async () => {
    const client = mockClient({
      clientOverrides: {
        health: vi.fn().mockRejectedValue(new Error("unreachable")),
        listByKind: vi.fn().mockRejectedValue(new Error("down")),
        listDecisions: vi.fn().mockRejectedValue(new Error("down")),
        listPatches: vi.fn().mockRejectedValue(new Error("down")),
        conflicts: vi.fn().mockRejectedValue(new Error("down")),
      },
    });
    const result = await buildBriefing(client);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics).toContain("health endpoint unreachable");
  });
});
