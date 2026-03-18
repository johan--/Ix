import { describe, it, expect } from "vitest";
import { humanizeLabel } from "../impact/risk-semantics.js";

/**
 * Tests for ix overview output structure.
 *
 * These verify that overview is purely structural and downward-facing:
 * kind, file path, system path, child counts, key items — no role/risk/dependency content.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeClassOutput() {
  return {
    resolvedTarget: { id: "abc-123", kind: "class", name: "IxClient" },
    resolutionMode: "exact",
    path: "src/client/api.ts",
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
      { name: "api.ts", kind: "file" },
      { name: "IxClient", kind: "class" },
    ],
    hasMapData: true,
    childrenByKind: { method: 18, field: 7 },
    keyItems: [
      { name: "get", kind: "method" },
      { name: "post", kind: "method" },
      { name: "entity", kind: "method" },
      { name: "listByKind", kind: "method" },
      { name: "listPatches", kind: "method" },
    ],
    diagnostics: [],
  };
}

function makeFileOutput() {
  return {
    resolvedTarget: { id: "file-abc", kind: "file", name: "Node.scala" },
    resolutionMode: "exact",
    path: "memory-layer/src/main/scala/ix/memory/model/Node.scala",
    systemPath: [
      { name: "API", kind: "system" },
      { name: "Model / Db", kind: "subsystem" },
      { name: "Node.scala", kind: "file" },
    ],
    hasMapData: true,
    childrenByKind: { interface: 1, class: 1, object: 1 },
    keyItems: [
      { name: "NodeKind", kind: "interface" },
      { name: "Node", kind: "class" },
      { name: "NodeId", kind: "object" },
    ],
    diagnostics: [],
  };
}

function makeRegionOutput() {
  return {
    resolvedTarget: { id: "reg-1", kind: "subsystem", name: "Cli / Client" },
    resolutionMode: "exact",
    path: null,
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
    ],
    hasMapData: true,
    childrenByKind: { file: 12, class: 3, function: 28 },
    keyItems: [
      { name: "api.ts", kind: "file" },
      { name: "resolve.ts", kind: "file" },
      { name: "status.ts", kind: "file" },
    ],
    diagnostics: [],
  };
}

function makeFunctionOutput() {
  return {
    resolvedTarget: { id: "fn-1", kind: "function", name: "pickBest" },
    resolutionMode: "exact",
    path: "src/cli/resolve.ts",
    systemPath: [
      { name: "CLI", kind: "system" },
      { name: "Cli / Client", kind: "subsystem" },
      { name: "resolve.ts", kind: "file" },
      { name: "pickBest", kind: "function" },
    ],
    hasMapData: true,
    childrenByKind: null,
    keyItems: null,
    diagnostics: [],
  };
}

// ── Class target ────────────────────────────────────────────────────────────

describe("overview: class target", () => {
  it("has child counts by kind", () => {
    const output = makeClassOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.method).toBe(18);
    expect(output.childrenByKind!.field).toBe(7);
  });

  it("has key members", () => {
    const output = makeClassOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.length).toBeLessThanOrEqual(5);
    expect(output.keyItems!.map((i) => i.name)).toContain("get");
  });

  it("has no callers, dependents, or risk text", () => {
    const output = makeClassOutput();
    const keys = Object.keys(output);
    expect(keys).not.toContain("callers");
    expect(keys).not.toContain("dependents");
    expect(keys).not.toContain("riskSummary");
    expect(keys).not.toContain("riskLevel");
    expect(keys).not.toContain("importers");
    expect(keys).not.toContain("usedBy");
  });
});

// ── File target ─────────────────────────────────────────────────────────────

describe("overview: file target", () => {
  it("summarizes definitions structurally", () => {
    const output = makeFileOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.interface).toBe(1);
    expect(output.childrenByKind!.class).toBe(1);
  });

  it("has key definitions", () => {
    const output = makeFileOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.map((i) => i.name)).toContain("NodeKind");
  });

  it("has no role or risk text", () => {
    const output = makeFileOutput();
    const keys = Object.keys(output);
    expect(keys).not.toContain("riskSummary");
    expect(keys).not.toContain("whyItMatters");
    expect(keys).not.toContain("atRiskBehavior");
  });

  it("uses repo-relative path", () => {
    const output = makeFileOutput();
    expect(output.path).not.toMatch(/^\//);
  });
});

// ── Region/subsystem target ─────────────────────────────────────────────────

describe("overview: region/subsystem target", () => {
  it("shows child files/regions structurally", () => {
    const output = makeRegionOutput();
    expect(output.childrenByKind).not.toBeNull();
    expect(output.childrenByKind!.file).toBe(12);
  });

  it("has key files", () => {
    const output = makeRegionOutput();
    expect(output.keyItems).not.toBeNull();
    expect(output.keyItems!.map((i) => i.name)).toContain("api.ts");
  });

  it("has no path for region targets", () => {
    const output = makeRegionOutput();
    expect(output.path).toBeNull();
  });
});

// ── Method/function target ──────────────────────────────────────────────────

describe("overview: method/function target", () => {
  it("stays minimal with no fake contained structure", () => {
    const output = makeFunctionOutput();
    expect(output.childrenByKind).toBeNull();
    expect(output.keyItems).toBeNull();
  });

  it("has file and system path", () => {
    const output = makeFunctionOutput();
    expect(output.path).toBe("src/cli/resolve.ts");
    expect(output.systemPath!.length).toBeGreaterThan(1);
  });

  it("system path ends with the function name", () => {
    const output = makeFunctionOutput();
    const last = output.systemPath![output.systemPath!.length - 1];
    expect(last.name).toBe("pickBest");
  });
});

// ── Humanized system path ───────────────────────────────────────────────────

describe("overview: humanized system path labels", () => {
  it("region labels are humanized", () => {
    const humanized = humanizeLabel("Cli / Client").replace(/ layer$/, "");
    expect(humanized).toBe("CLI client");
  });

  it("raw suffixes are stripped", () => {
    const humanized = humanizeLabel("Model (2f)").replace(/ layer$/, "");
    expect(humanized).not.toContain("(2f)");
  });
});

// ── No-overlap regression ───────────────────────────────────────────────────

describe("overview: no-overlap regression", () => {
  const allOutputs = [makeClassOutput(), makeFileOutput(), makeRegionOutput(), makeFunctionOutput()];
  const allKeys = new Set(allOutputs.flatMap((o) => Object.keys(o)));

  it("does not include 'usedBy' or 'whyItMatters'", () => {
    expect(allKeys.has("usedBy")).toBe(false);
    expect(allKeys.has("whyItMatters")).toBe(false);
  });

  it("does not include risk fields", () => {
    expect(allKeys.has("riskSummary")).toBe(false);
    expect(allKeys.has("riskLevel")).toBe(false);
    expect(allKeys.has("riskCategory")).toBe(false);
    expect(allKeys.has("atRiskBehavior")).toBe(false);
  });

  it("does not include callers/dependents/importers", () => {
    expect(allKeys.has("callers")).toBe(false);
    expect(allKeys.has("callerList")).toBe(false);
    expect(allKeys.has("dependents")).toBe(false);
    expect(allKeys.has("directDependents")).toBe(false);
    expect(allKeys.has("directImporters")).toBe(false);
    expect(allKeys.has("importers")).toBe(false);
  });

  it("does not include imports count", () => {
    // imports belonged to the old overview — now removed
    for (const o of allOutputs) {
      expect((o as any).summary?.imports).toBeUndefined();
    }
  });
});
