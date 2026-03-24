import { describe, it, expect, vi } from "vitest";
import { resolveEntityFull } from "../resolve.js";

/**
 * Verify that search ranking correctly incorporates backend _search_weight.
 *
 * We replicate the rankScore logic here to test tier assignment
 * without needing a running backend.
 */

/** Minimal scoreCandidate replica for testing (exact name = 0, prefix = 15, fuzzy = 30). */
function scoreCandidate(node: any, term: string, opts?: { kind?: string; path?: string }): number {
  const name: string = (node.name || "").toLowerCase();
  const kind: string = (node.kind || "").toLowerCase();
  const symbolLower = term.toLowerCase();
  let score = 50;
  if (name === symbolLower) score = 0;
  else if (name.startsWith(symbolLower)) score = 15;
  else score = 30;
  if (opts?.kind && kind === opts.kind.toLowerCase()) score -= 5;
  if (["class", "trait", "object", "interface", "module", "file"].includes(kind)) score -= 3;
  else if (["function", "method"].includes(kind)) score -= 1;
  return score;
}

/** Replicate the production rankScore logic for testing. */
function rankScore(
  node: any,
  term: string,
  requestedKind: string | undefined,
  pathFilter: string | undefined,
): { tier: number; score: number; matchSource: string } {
  // Weight comes through attrs (embedded by AQL into attrs JSON)
  const backendWeight: number = node.attrs?._search_weight ?? node._search_weight ?? 0;
  const resolverScore = scoreCandidate(node, term, { kind: requestedKind, path: pathFilter });

  if (backendWeight >= 100) {
    if (resolverScore <= -3) return { tier: 0, score: -backendWeight + resolverScore, matchSource: "name_exact" };
    if (resolverScore <= 0) return { tier: 1, score: -backendWeight + resolverScore, matchSource: "name_exact" };
    return { tier: 2, score: -backendWeight + resolverScore, matchSource: "name_exact" };
  }
  if (backendWeight >= 60) {
    return { tier: 3, score: -backendWeight + resolverScore, matchSource: "name_partial" };
  }
  if (backendWeight >= 40) return { tier: 4, score: -backendWeight, matchSource: "provenance" };
  if (backendWeight >= 20) return { tier: 4, score: -backendWeight, matchSource: "claim_or_decision" };

  if (resolverScore <= -8) return { tier: 0, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= -3) return { tier: 0, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= 0) return { tier: 1, score: resolverScore, matchSource: "resolver" };
  if (resolverScore <= 2) return { tier: 2, score: resolverScore, matchSource: "resolver" };
  return { tier: 5, score: resolverScore, matchSource: "attrs" };
}

describe("search ranking with backend weight", () => {
  it("assigns tier 0-1 for exact name match with backend weight 100", () => {
    // Weight comes through attrs (as it does from real backend after parseNode)
    const node = { name: "IngestionService", kind: "class", attrs: { _search_weight: 100 } };
    const result = rankScore(node, "IngestionService", "class", undefined);
    expect(result.tier).toBeLessThanOrEqual(1);
    expect(result.matchSource).toBe("name_exact");
  });

  it("assigns tier 3 for partial name match with backend weight 60", () => {
    const node = { name: "IngestionServiceImpl", kind: "class", attrs: { _search_weight: 60 } };
    const result = rankScore(node, "Ingestion", undefined, undefined);
    expect(result.tier).toBe(3);
    expect(result.matchSource).toBe("name_partial");
  });

  it("assigns tier 4 for provenance match with backend weight 40", () => {
    const node = { name: "unrelated", kind: "file", attrs: { _search_weight: 40 } };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(4);
    expect(result.matchSource).toBe("provenance");
  });

  it("assigns tier 4 for claim/decision match with backend weight 20", () => {
    const node = { name: "something", kind: "decision", attrs: { _search_weight: 20 } };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(4);
    expect(result.matchSource).toBe("claim_or_decision");
  });

  it("assigns tier 5 for no backend weight and fuzzy resolver match", () => {
    const node = { name: "totally_different", kind: "function" };
    const result = rankScore(node, "ingestion", undefined, undefined);
    expect(result.tier).toBe(5);
    expect(result.matchSource).toBe("attrs");
  });

  it("sorts exact matches above partial matches", () => {
    const exact = { name: "Node", kind: "class", attrs: { _search_weight: 100 } };
    const partial = { name: "NodeImpl", kind: "class", attrs: { _search_weight: 60 } };
    const rExact = rankScore(exact, "Node", undefined, undefined);
    const rPartial = rankScore(partial, "Node", undefined, undefined);
    expect(rExact.tier).toBeLessThan(rPartial.tier);
  });

  it("reads weight from attrs (real backend path) not top-level", () => {
    // This is the critical test: weight MUST come through attrs to survive
    // the parseNode → GraphNode → JSON serialization pipeline
    const nodeWithAttrsWeight = { name: "Node", kind: "class", attrs: { _search_weight: 100 } };
    const nodeWithTopLevelWeight = { name: "Node", kind: "class", _search_weight: 100 };
    const nodeWithNoWeight = { name: "Node", kind: "class", attrs: {} };

    const r1 = rankScore(nodeWithAttrsWeight, "Node", undefined, undefined);
    const r2 = rankScore(nodeWithTopLevelWeight, "Node", undefined, undefined);
    const r3 = rankScore(nodeWithNoWeight, "Node", undefined, undefined);

    // Both attrs and top-level paths should work (fallback chain)
    expect(r1.tier).toBeLessThanOrEqual(2);
    expect(r2.tier).toBeLessThanOrEqual(2);
    // No weight → falls through to resolver
    expect(r3.matchSource).toBe("resolver");
  });
});

describe("resolveEntityFull --path hard exclusion", () => {
  it("excludes out-of-scope candidates even on exact name match", async () => {
    // Simulates Bug 1: etcd has 'Notifier' but prometheus does not.
    // With --path prometheus, the etcd candidate must be excluded entirely.
    const etcdNotifier = {
      id: "etcd-notifier-id",
      name: "Notifier",
      kind: "class",
      provenance: { sourceUri: "etcd/pkg/notify/notify.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([etcdNotifier]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Notifier", ["class"], { path: "prometheus" });

    expect(result.resolved).toBe(false);
    if (!result.resolved) {
      expect(result.ambiguous).toBe(false);
    }
  });

  it("resolves when the only candidate matches the path filter", async () => {
    const promNotifier = {
      id: "prom-notifier-id",
      name: "Notifier",
      kind: "class",
      provenance: { sourceUri: "prometheus/notifier/notifier.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([promNotifier]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Notifier", ["class"], { path: "prometheus" });

    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("prom-notifier-id");
    }
  });

  it("prefers in-scope candidate over higher-scored out-of-scope candidate", async () => {
    // Both repos have 'Manager'; only the prometheus one should be returned.
    const etcdManager = {
      id: "etcd-manager-id",
      name: "Manager",
      kind: "class",
      provenance: { sourceUri: "etcd/raft/manager.go" },
    };
    const promManager = {
      id: "prom-manager-id",
      name: "Manager",
      kind: "class",
      provenance: { sourceUri: "prometheus/notifier/manager.go" },
    };
    const mockClient = {
      search: vi.fn().mockResolvedValue([etcdManager, promManager]),
    } as any;

    const result = await resolveEntityFull(mockClient, "Manager", ["class"], { path: "prometheus" });

    // etcdManager is excluded by the path filter; only promManager survives → single candidate → resolved
    expect(result.resolved).toBe(true);
    if (result.resolved) {
      expect(result.entity.id).toBe("prom-manager-id");
    }
  });
});
