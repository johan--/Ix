# Stabilize and Optimize Existing Ix Workflows — Design

**Goal:** Fix broken high-level commands, make JSON mode fully strict, improve defaults for agent safety.

**Scope:** Backend list endpoint, rank/inventory fixes, JSON audit, safer search defaults, doc updates. Diff optimization and callers fallback changes deferred — both already work.

---

## 1. Fix rank and inventory

**Root cause:** Both commands use `client.search("", { kind })` which matches everything in ArangoDB (CONTAINS with empty string returns true for all values). The backend already has `findNodesByKind()` but no REST route exposes it.

**Backend change:** Add `POST /v1/list` route exposing `findNodesByKind()`. Request: `{ kind: string, limit?: number }`. Response: array of GraphNode. ~30 lines of Scala.

**CLI client:** Add `IxClient.listByKind(kind, opts?)` method calling `POST /v1/list`.

**inventory.ts:** Replace `client.search("")` with `client.listByKind()`. Add client-side path filtering on provenance source_uri.

**rank.ts:** Same replacement. Ranking logic stays the same.

## 2. Strict JSON cleanup

**Already done:** `resolve.ts` routes all diagnostics to stderr (previous patch Task 2).

**Remaining:** Audit all command files for unguarded `console.log` calls that leak to stdout in JSON mode. Fix any found to use `stderr()` or format guards. Remove stray `console.log("CLI depth:")` in api.ts.

## 3. Safer search defaults

Lower default search limit from 20 to 10. Add `unfiltered_search` diagnostic when no `--kind` filter used.

## 4. Doc updates

Update AGENTS.md, CLAUDE.md to reflect working rank/inventory, emphasize `--kind` on search, keep high-level commands as preferred entry points.

## Deferred

- Diff server-side summary optimization — current client-side summary works
- Callers fallback tightening — already bounded (10 matches max)
