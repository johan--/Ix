import { describe, it, expect } from "vitest";
import { inferRole } from "../explain/role-inference.js";
import { inferImportance } from "../explain/importance.js";
import { renderExplanation } from "../explain/render.js";
import type { EntityFacts } from "../explain/facts.js";

function makeFacts(overrides: Partial<EntityFacts> = {}): EntityFacts {
  return {
    id: "test-id-1234",
    name: "SomeEntity",
    kind: "function",
    path: "src/example.ts",
    signature: undefined,
    docstring: undefined,
    container: undefined,
    members: [],
    memberCount: 0,
    callerCount: 2,
    calleeCount: 1,
    dependentCount: 3,
    importerCount: 1,
    downstreamDependents: 4,
    downstreamDepth: 2,
    topCallers: [],
    topDependents: [],
    introducedRev: 1,
    historyLength: 2,
    callList: undefined,
    stale: false,
    diagnostics: [],
    ...overrides,
  };
}

// ── Role inference ──────────────────────────────────────────────────────────

describe("inferRole", () => {
  it("detects test entities by name", () => {
    const facts = makeFacts({ name: "AuthServiceTest", path: "src/__tests__/auth.ts" });
    const result = inferRole(facts);
    expect(result.role).toBe("test");
    expect(result.confidence).toBe("high");
  });

  it("detects test entities by path containing spec", () => {
    const facts = makeFacts({ name: "describe", path: "src/auth.spec.ts" });
    const result = inferRole(facts);
    expect(result.role).toBe("test");
  });

  it("detects configuration entities", () => {
    const facts = makeFacts({ kind: "config_entry", name: "databaseConfig" });
    const result = inferRole(facts);
    expect(result.role).toBe("configuration");
    expect(result.confidence).toBe("high");
  });

  it("detects type definitions", () => {
    const facts = makeFacts({ kind: "interface", name: "UserProps" });
    const result = inferRole(facts);
    expect(result.role).toBe("type-definition");
    expect(result.confidence).toBe("high");
  });

  it("detects API client by class name and methods", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      calleeCount: 0,
      dependentCount: 20,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("api-client");
    expect(result.confidence).toBe("high");
  });

  it("detects API client even without path signals if methods match", () => {
    const facts = makeFacts({
      kind: "class",
      name: "BackendClient",
      path: "src/service.ts",
      memberCount: 5,
      members: ["get", "post", "delete", "fetch"],
      callerCount: 4,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("api-client");
  });

  it("does NOT classify IxClient-like class as data-model", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get"],
      callerCount: 12,
      calleeCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).not.toBe("data-model");
  });

  it("detects registration functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "registerExplainCommand",
      path: "src/cli/commands/explain.ts",
      callerCount: 1,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("registration-function");
    expect(result.confidence).toBe("high");
  });

  it("detects resolution helpers", () => {
    const facts = makeFacts({
      kind: "function",
      name: "resolveFileOrEntity",
      path: "src/cli/resolve.ts",
      callerCount: 10,
      calleeCount: 5,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("resolution-helper");
  });

  it("detects selection helpers like pickBest", () => {
    const facts = makeFacts({
      kind: "function",
      name: "pickBest",
      path: "src/cli/resolve.ts",
      callerCount: 1,
      calleeCount: 3,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("selection-helper");
    expect(result.reasons.some((r) => r.includes("selection"))).toBe(true);
  });

  it("detects scoring helpers by name", () => {
    const facts = makeFacts({
      kind: "function",
      name: "scoreCandidate",
      path: "src/cli/importance.ts",
      callerCount: 2,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("detects scoring helpers by file path", () => {
    const facts = makeFacts({
      kind: "function",
      name: "evaluate",
      path: "src/ranking/score.ts",
      callerCount: 3,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("detects services by naming and structure", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["ingest", "parse", "validate", "store", "notify"],
    });
    const result = inferRole(facts);
    expect(result.role).toBe("service");
    expect(result.confidence).toBe("high");
  });

  it("detects service methods via container context", () => {
    const facts = makeFacts({
      kind: "method",
      name: "processPayment",
      path: "src/billing.ts",
      container: { kind: "class", name: "PaymentService" },
      callerCount: 3,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("service-method");
    expect(result.confidence).toBe("high");
    expect(result.reasons.some((r) => r.includes("PaymentService"))).toBe(true);
  });

  it("detects entry points (no callers, has callees)", () => {
    const facts = makeFacts({
      kind: "function",
      name: "main",
      callerCount: 0,
      calleeCount: 3,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("entry-point");
    expect(result.confidence).toBe("high");
  });

  it("detects shared utility functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "formatDate",
      callerCount: 5,
      calleeCount: 0,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("shared-utility");
    expect(result.confidence).toBe("medium");
  });

  it("detects adapters by name", () => {
    const facts = makeFacts({
      kind: "class",
      name: "DatabaseGateway",
      callerCount: 2,
      calleeCount: 3,
      memberCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("adapter");
  });

  it("detects localized helpers", () => {
    const facts = makeFacts({
      kind: "function",
      name: "doStuff",
      callerCount: 1,
      calleeCount: 1,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("localized-helper");
    expect(result.confidence).toBe("medium");
  });

  it("uses container context for unknown-fallback functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      container: { kind: "class", name: "Foo" },
    });
    const result = inferRole(facts);
    // Should NOT say "role could not be determined"
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
    expect(result.reasons.some((r) => r.includes("Foo"))).toBe(true);
  });

  it("uses file context for unknown-fallback functions", () => {
    const facts = makeFacts({
      kind: "function",
      name: "x",
      path: "src/cli/helpers.ts",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
    });
    const result = inferRole(facts);
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
    expect(result.reasons.some((r) => r.includes("helpers"))).toBe(true);
  });

  it("never says 'role could not be determined' for entities with file context", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const result = inferRole(facts);
    expect(result.reasons.join(" ")).not.toContain("could not be determined");
  });
});

// ── Importance inference ────────────────────────────────────────────────────

describe("inferImportance", () => {
  it("marks high importance for many dependents (broad-shared-dependency)", () => {
    const facts = makeFacts({ dependentCount: 12, callerCount: 8, downstreamDependents: 20 });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("broad-shared-dependency");
    expect(result.reasons.some((r) => r.includes("dependents"))).toBe(true);
  });

  it("marks high importance for many callers", () => {
    const facts = makeFacts({ callerCount: 10, downstreamDependents: 15 });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("broad-shared-dependency");
  });

  it("marks low importance for isolated entities", () => {
    const facts = makeFacts({
      dependentCount: 0,
      callerCount: 0,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 0,
      downstreamDepth: 0,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("low");
  });

  it("marks medium importance for moderate connectivity", () => {
    const facts = makeFacts({
      dependentCount: 3,
      callerCount: 2,
      importerCount: 1,
      downstreamDependents: 5,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("medium");
    expect(result.category).toBe("normal");
  });

  it("detects pipeline choke point (low callers, high downstream)", () => {
    const facts = makeFacts({
      callerCount: 1,
      dependentCount: 2,
      importerCount: 0,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const result = inferImportance(facts);
    expect(result.level).toBe("high");
    expect(result.category).toBe("pipeline-choke-point");
    expect(result.reasons.some((r) => r.includes("downstream dependents"))).toBe(true);
  });

  it("detects localized helper (low callers, small downstream)", () => {
    const facts = makeFacts({
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const result = inferImportance(facts);
    expect(result.category).toBe("localized-helper");
  });

  it("does NOT mark as choke point if callers are high", () => {
    const facts = makeFacts({
      callerCount: 8,
      downstreamDependents: 30,
    });
    const result = inferImportance(facts);
    expect(result.category).toBe("broad-shared-dependency");
    expect(result.category).not.toBe("pipeline-choke-point");
  });
});

// ── Rendering ───────────────────────────────────────────────────────────────

describe("renderExplanation", () => {
  it("uses confident language for high-confidence roles", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).not.toContain("appears to be");
  });

  it("uses hedged language for low-confidence roles", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("appears to be");
  });

  it("includes container context in explanation for service methods", () => {
    const facts = makeFacts({
      kind: "method",
      name: "resolve",
      container: { kind: "class", name: "ConflictService" },
      callerCount: 3,
      calleeCount: 2,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("ConflictService");
  });

  it("includes container context when present", () => {
    const facts = makeFacts({
      container: { kind: "class", name: "OrderService" },
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).toContain("Container: class OrderService");
  });

  it("includes downstream dependents in context", () => {
    const facts = makeFacts({ downstreamDependents: 15, downstreamDepth: 3 });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.context).toContain("Downstream dependents: 15");
  });

  it("renders named usage examples when callers exist", () => {
    const facts = makeFacts({
      callerCount: 5,
      topCallers: ["registerImpactCommand", "registerOverviewCommand", "registerExplainCommand"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.usedBy).not.toBeNull();
    expect(rendered.usedBy).toContain("registerImpactCommand");
    expect(rendered.usedBy).toContain("registerOverviewCommand");
  });

  it("returns null usedBy when no examples available", () => {
    const facts = makeFacts({ callerCount: 0, topCallers: [], topDependents: [] });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.usedBy).toBeNull();
  });

  it("fuses role context into why-it-matters for api-client", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("central API client");
    expect(rendered.whyItMatters).toContain("ix impact");
  });

  it("renders pipeline choke point wording for narrow-but-critical nodes", () => {
    const facts = makeFacts({
      name: "pickBest",
      callerCount: 1,
      dependentCount: 2,
      downstreamDependents: 25,
      downstreamDepth: 3,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("pipeline-choke-point");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("only 1 direct caller");
    expect(rendered.whyItMatters).toContain("25 downstream dependents");
    expect(rendered.whyItMatters).toContain("structurally important");
  });

  it("renders localized helper wording for low-impact nodes", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("localized-helper");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("localized");
  });

  it("cleans unresolved_call_target into human-readable note", () => {
    const facts = makeFacts({
      diagnostics: [
        { code: "unresolved_call_target", message: "3 callee(s) could not be resolved." },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.notes.length).toBe(1);
    expect(rendered.notes[0]).not.toContain("[unresolved_call_target]");
    expect(rendered.notes[0]).toContain("could not be resolved");
  });

  it("cleans stale_source into human-readable note", () => {
    const facts = makeFacts({
      diagnostics: [
        { code: "stale_source", message: "stale" },
      ],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.notes[0]).toContain("changed since last ingest");
    expect(rendered.notes[0]).not.toContain("[stale_source]");
  });
});

// ── Confidence-to-language tiers ─────────────────────────────────────────────

describe("confidence-to-language mapping", () => {
  it("high-confidence roles use 'serves as', never 'likely' or 'appears'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["ingest", "parse", "validate", "store", "notify"],
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).not.toContain("is likely");
    expect(rendered.explanation).not.toContain("appears to be");
  });

  it("medium-confidence roles use 'is likely'", () => {
    const facts = makeFacts({
      kind: "function",
      name: "formatDate",
      callerCount: 5,
      calleeCount: 0,
      memberCount: 0,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("medium");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("is likely");
    expect(rendered.explanation).not.toContain("serves as");
  });

  it("low-confidence roles use 'appears to be'", () => {
    const facts = makeFacts({
      kind: "variable",
      name: "x",
      callerCount: 0,
      calleeCount: 0,
      memberCount: 0,
      path: "src/utils.ts",
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("low");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.explanation).toContain("appears to be");
    expect(rendered.explanation).not.toContain("serves as");
    expect(rendered.explanation).not.toContain("is likely");
  });

  it("high-confidence broad dependency uses 'will propagate' not 'likely to affect'", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IxClient",
      path: "src/client/api.ts",
      memberCount: 15,
      members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch"],
      callerCount: 12,
      dependentCount: 20,
      downstreamDependents: 35,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("high");
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("will propagate");
    expect(rendered.whyItMatters).not.toContain("likely to affect");
  });

  it("medium-confidence broad dependency uses 'may propagate'", () => {
    // Force medium confidence via a class with client methods but no name/path signals
    const facts = makeFacts({
      kind: "class",
      name: "DataHub",
      path: "src/core.ts",
      memberCount: 4,
      members: ["get", "post", "fetch", "query"],
      callerCount: 10,
      calleeCount: 3,
      dependentCount: 12,
      downstreamDependents: 20,
    });
    const role = inferRole(facts);
    expect(role.confidence).toBe("medium");
    const importance = inferImportance(facts);
    expect(importance.category).toBe("broad-shared-dependency");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("may propagate");
  });

  it("localized helper uses 'is localized' not 'appears localized'", () => {
    const facts = makeFacts({
      name: "trimWhitespace",
      callerCount: 1,
      dependentCount: 1,
      importerCount: 0,
      memberCount: 0,
      downstreamDependents: 2,
      downstreamDepth: 1,
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    expect(importance.category).toBe("localized-helper");
    const rendered = renderExplanation(facts, role, importance);
    expect(rendered.whyItMatters).toContain("is localized");
    expect(rendered.whyItMatters).not.toContain("appears localized");
  });
});

// ── File-based role inference ───────────────────────────────────────────────

describe("file-based role inference", () => {
  it("inferImportance function in importance.ts → scoring-helper", () => {
    const facts = makeFacts({
      kind: "function",
      name: "inferImportance",
      path: "src/cli/explain/importance.ts",
      callerCount: 2,
      calleeCount: 1,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("scoring-helper");
  });

  it("resolve in api.ts file stays resolution-helper", () => {
    const facts = makeFacts({
      kind: "function",
      name: "resolvePrefix",
      path: "src/client/api.ts",
      callerCount: 3,
      calleeCount: 2,
    });
    const result = inferRole(facts);
    expect(result.role).toBe("resolution-helper");
  });
});

// ── Fixture-like regression tests ───────────────────────────────────────────

describe("fixture regression: IxClient", () => {
  const ixClientFacts = makeFacts({
    kind: "class",
    name: "IxClient",
    path: "ix-cli/src/client/api.ts",
    memberCount: 15,
    members: ["query", "search", "entity", "expand", "ingest", "post", "get", "patch",
              "decide", "provenance", "listPatches", "stats", "listByKind", "listDecisions", "resolvePrefix"],
    callerCount: 12,
    calleeCount: 0,
    dependentCount: 20,
    importerCount: 8,
    downstreamDependents: 35,
    downstreamDepth: 3,
    topCallers: ["registerImpactCommand", "registerOverviewCommand", "registerExplainCommand"],
  });

  it("infers api-client role, not data-model", () => {
    const role = inferRole(ixClientFacts);
    expect(role.role).toBe("api-client");
    expect(role.role).not.toBe("data-model");
    expect(role.confidence).toBe("high");
  });

  it("infers high importance as broad shared dependency", () => {
    const importance = inferImportance(ixClientFacts);
    expect(importance.level).toBe("high");
    expect(importance.category).toBe("broad-shared-dependency");
  });

  it("renders confident explanation with API client and named examples", () => {
    const role = inferRole(ixClientFacts);
    const importance = inferImportance(ixClientFacts);
    const rendered = renderExplanation(ixClientFacts, role, importance);
    expect(rendered.explanation).toContain("serves as");
    expect(rendered.explanation).toContain("API client");
    expect(rendered.whyItMatters).toContain("central API client");
    expect(rendered.usedBy).toContain("registerImpactCommand");
  });
});

describe("fixture regression: pickBest", () => {
  const pickBestFacts = makeFacts({
    kind: "function",
    name: "pickBest",
    path: "ix-cli/src/cli/resolve.ts",
    callerCount: 1,
    calleeCount: 3,
    dependentCount: 2,
    importerCount: 0,
    memberCount: 0,
    downstreamDependents: 25,
    downstreamDepth: 3,
    topCallers: ["resolveFileOrEntity"],
  });

  it("infers selection-helper role, not unknown", () => {
    const role = inferRole(pickBestFacts);
    expect(role.role).toBe("selection-helper");
    expect(role.role).not.toBe("unknown");
  });

  it("infers pipeline choke point importance", () => {
    const importance = inferImportance(pickBestFacts);
    expect(importance.level).toBe("high");
    expect(importance.category).toBe("pipeline-choke-point");
  });

  it("renders choke point wording, not 'moderate impact'", () => {
    const role = inferRole(pickBestFacts);
    const importance = inferImportance(pickBestFacts);
    const rendered = renderExplanation(pickBestFacts, role, importance);
    expect(rendered.whyItMatters).not.toContain("Moderate impact");
    expect(rendered.whyItMatters).toContain("downstream dependents");
    expect(rendered.whyItMatters).toContain("structurally important");
  });

  it("includes named usage example", () => {
    const role = inferRole(pickBestFacts);
    const importance = inferImportance(pickBestFacts);
    const rendered = renderExplanation(pickBestFacts, role, importance);
    expect(rendered.usedBy).toContain("resolveFileOrEntity");
  });
});

// ── Distinction from overview ───────────────────────────────────────────────

describe("explain vs overview distinction", () => {
  it("explain output includes role, importance category, and rendered sections that overview lacks", () => {
    const facts = makeFacts({
      kind: "class",
      name: "IngestionService",
      memberCount: 5,
      members: ["a", "b", "c", "d", "e"],
    });
    const role = inferRole(facts);
    const importance = inferImportance(facts);
    const rendered = renderExplanation(facts, role, importance);

    expect(role.role).toBeDefined();
    expect(role.confidence).toBeDefined();
    expect(importance.level).toBeDefined();
    expect(importance.category).toBeDefined();
    expect(rendered.explanation).toBeDefined();
    expect(rendered.whyItMatters).toBeDefined();
    expect(rendered.notes).toBeDefined();
  });
});
