import type { EntityFacts } from "./facts.js";
import type { RoleInference, RoleLabel } from "./role-inference.js";
import type { ImportanceInference } from "./importance.js";

export interface ExplanationOutput {
  explanation: string;
  context: string;
  usedBy: string | null;
  whyItMatters: string;
  notes: string[];
}

// ── Role description templates ──────────────────────────────────────────────

/** Build a role description that incorporates container/file context when available. */
function describeRole(role: RoleLabel, facts: EntityFacts): string {
  const containerName = facts.container?.name;
  const file = fileBaseName(facts.path);

  switch (role) {
    case "test":
      return "a test or specification";
    case "configuration":
      return "a configuration source";
    case "type-definition":
      return "a type definition";
    case "data-model":
      return "a data model";
    case "api-client":
      return "the main backend API client for the CLI";
    case "entry-point":
      return "an entry point";
    case "registration-function":
      return file
        ? `a command registration function in ${file}`
        : "a command registration function";
    case "service":
      return "a service coordinating multiple operations";
    case "service-method":
      return containerName
        ? `a method within ${containerName}`
        : "a service method";
    case "adapter":
      return "an adapter bridging external systems";
    case "orchestrator":
      return "an orchestrator coordinating multiple downstream operations";
    case "resolution-helper":
      return containerName
        ? `a resolution method inside ${containerName}`
        : file
          ? `a shared resolution method in the ${file} pipeline`
          : "a resolution or lookup helper";
    case "selection-helper":
      return containerName
        ? `a selection helper inside ${containerName}`
        : file
          ? `a selection helper in the ${file} pipeline`
          : "a selection helper that picks or ranks candidates";
    case "scoring-helper":
      return file
        ? `a scoring function used by the ${file} pipeline`
        : "a scoring or ranking helper";
    case "container":
      return `a container module with ${facts.memberCount} members`;
    case "shared-utility":
      return "a widely shared utility function";
    case "localized-helper":
      if (containerName) return `a helper within ${containerName}`;
      if (file) return `a localized helper defined in ${file}`;
      return "a localized internal helper";
    case "unknown":
      // Context-aware fallback — never say "role could not be determined"
      if (containerName) return `a member of ${containerName}`;
      if (file) return `a localized helper defined in ${file}`;
      return "a localized internal helper";
  }
}

function fileBaseName(path?: string): string {
  if (!path) return "";
  const base = path.split("/").pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

// ── Confidence-to-language mapping ───────────────────────────────────────────

function phrasingForConfidence(confidence: "low" | "medium" | "high"): {
  roleVerb: string;
  impactVerb: string;
} {
  if (confidence === "high") return { roleVerb: "serves as", impactVerb: "will" };
  if (confidence === "medium") return { roleVerb: "is likely", impactVerb: "may" };
  return { roleVerb: "appears to be", impactVerb: "may" };
}

// ── Main render ─────────────────────────────────────────────────────────────

export function renderExplanation(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
): ExplanationOutput {
  // ── Explanation ────────────────────────────────────────────────────────
  const roleDesc = describeRole(role.role, facts);
  const phrasing = phrasingForConfidence(role.confidence);
  let explanation = `\`${facts.name}\` ${phrasing.roleVerb} ${roleDesc}.`;

  if (facts.signature) {
    explanation += ` Signature: \`${facts.signature}\`.`;
  }

  if (facts.docstring) {
    explanation += ` ${facts.docstring}`;
  }

  // ── Context ───────────────────────────────────────────────────────────
  const contextLines: string[] = [];

  if (facts.path) {
    contextLines.push(`Defined in: ${facts.path}`);
  }

  if (facts.container) {
    contextLines.push(`Container: ${facts.container.kind} ${facts.container.name}`);
  }

  if (facts.callerCount > 0) {
    contextLines.push(`Called by: ${facts.callerCount} entities`);
  }

  if (facts.calleeCount > 0) {
    contextLines.push(`Calls: ${facts.calleeCount} entities`);
  }

  if (facts.memberCount > 0) {
    contextLines.push(`Contains: ${facts.memberCount} members`);
  }

  if (facts.importerCount > 0) {
    contextLines.push(`Imported by: ${facts.importerCount} modules`);
  }

  if (facts.downstreamDependents > 0) {
    contextLines.push(`Downstream dependents: ${facts.downstreamDependents} (depth ${facts.downstreamDepth})`);
  }

  if (facts.introducedRev !== undefined) {
    contextLines.push(`First seen: rev ${facts.introducedRev}`);
  }

  if (facts.historyLength > 0) {
    contextLines.push(`Patch history: ${facts.historyLength} patches`);
  }

  const context = contextLines.join("\n");

  // ── Used by (named examples) ──────────────────────────────────────────
  const usedBy = renderUsedBy(facts);

  // ── Why it matters (role + importance fusion) ─────────────────────────
  const whyItMatters = renderWhyItMatters(facts, role, importance, phrasing);

  // ── Notes (clean diagnostics) ─────────────────────────────────────────
  const notes = renderNotes(facts);

  return { explanation, context, usedBy, whyItMatters, notes };
}

// ── Used by ─────────────────────────────────────────────────────────────────

function renderUsedBy(facts: EntityFacts): string | null {
  const examples = facts.topCallers.length > 0
    ? facts.topCallers
    : facts.topDependents;

  if (examples.length === 0) return null;

  const total = Math.max(facts.callerCount, facts.dependentCount);

  if (examples.length === 1) {
    if (total > 1) {
      return `Used by ${examples[0]} and ${total - 1} other${total - 1 === 1 ? "" : "s"}.`;
    }
    return `Used by ${examples[0]}.`;
  }

  const listed = examples.slice(0, 3).join(", ");
  const remaining = total - examples.length;
  if (remaining > 0) {
    return `Used by ${listed}, and ${remaining} other${remaining === 1 ? "" : "s"}.`;
  }
  return `Used by ${listed}.`;
}

// ── Why it matters ──────────────────────────────────────────────────────────

function renderWhyItMatters(
  facts: EntityFacts,
  role: RoleInference,
  importance: ImportanceInference,
  phrasing: { roleVerb: string; impactVerb: string },
): string {
  const { level, category } = importance;
  const verb = phrasing.impactVerb; // "will" for high confidence, "may" for medium/low

  if (category === "pipeline-choke-point") {
    const callerPhrase = facts.callerCount === 1
      ? "only 1 direct caller"
      : `only ${facts.callerCount} direct callers`;
    return (
      `Although it has ${callerPhrase}, it sits in a path with ` +
      `${facts.downstreamDependents} downstream dependents, making it a ` +
      `structurally important decision point in the pipeline. ` +
      `Consider running \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (category === "broad-shared-dependency") {
    const roleContext = roleFusionPhrase(role.role, facts);
    if (roleContext) {
      return (
        `${roleContext}, changes here ${verb} propagate across the codebase. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }
    const reasonStr = importance.reasons.length > 0
      ? importance.reasons[0]
      : "High connectivity";
    return (
      `${reasonStr}. This is a central shared dependency — changes ${verb} propagate broadly. ` +
      `Run \`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (category === "localized-helper") {
    return (
      "Its usage is localized, suggesting it is a narrow internal helper " +
      "with limited system-wide impact."
    );
  }

  // normal category
  if (level === "high") {
    const roleContext = roleFusionPhrase(role.role, facts);
    if (roleContext) {
      return (
        `${roleContext}, changes here ${verb} have wide impact. ` +
        `Run \`ix impact ${facts.name}\` before modifying.`
      );
    }
    const reasonStr = importance.reasons.length > 0
      ? importance.reasons[0]
      : "This entity has high connectivity";
    return (
      `${reasonStr}. Changes here ${verb} have wide impact — run ` +
      `\`ix impact ${facts.name}\` before modifying.`
    );
  }

  if (level === "low") {
    return (
      "Minimal inbound connections. " +
      "Changes are unlikely to affect other parts of the codebase."
    );
  }

  // medium / normal
  const reasonStr = importance.reasons.length > 0
    ? importance.reasons[0]
    : "Moderate connectivity";
  return (
    `${reasonStr}. ` +
    "Review callers before making breaking changes."
  );
}

/** Generate a role-specific lead phrase for why-it-matters. */
function roleFusionPhrase(role: RoleLabel, facts: EntityFacts): string | null {
  switch (role) {
    case "api-client":
      return `As the central API client used across ${facts.callerCount > 0 ? facts.callerCount + " commands" : "the codebase"}`;
    case "service":
      return `As a core service with ${facts.memberCount} methods`;
    case "shared-utility":
      return `As a shared utility called by ${facts.callerCount} entities`;
    case "resolution-helper":
      return `As a resolution helper in the matching pipeline`;
    case "orchestrator":
      return `As an orchestrator coordinating ${facts.calleeCount} operations`;
    default:
      return null;
  }
}

// ── Notes (human-readable diagnostics) ──────────────────────────────────────

function renderNotes(facts: EntityFacts): string[] {
  const notes: string[] = [];
  for (const d of facts.diagnostics) {
    switch (d.code) {
      case "unresolved_call_target":
        notes.push("Some downstream calls could not be resolved to named entities. Run `ix ingest` to improve coverage.");
        break;
      case "stale_source":
        notes.push("Source file has changed since last ingest — results may be incomplete.");
        break;
      default:
        notes.push(d.message);
    }
  }
  return notes;
}
