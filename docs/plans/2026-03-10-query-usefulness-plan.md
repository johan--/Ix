# Query Usefulness: REFERENCES Wiring + Integration Tests

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make parser-emitted REFERENCES edges actually power CLI dependency queries, so `ix depends NodeKind`, `ix callers registerExplainCommand`, and `ix overview` return materially useful results.

**Architecture:** The backend already stores and queries REFERENCES edges correctly — the gap is purely in CLI command files that hardcode predicate arrays without `"REFERENCES"`. Fix is additive: add `"REFERENCES"` to predicate lists in 7 CLI command files, update the `DependencyNode` type in `depends.ts`, add `"referenced-by"` relationship in `locate.ts`, and add ArangoDB-dependent integration tests.

**Tech Stack:** TypeScript (CLI commands, vitest), Scala (integration tests, scalatest + ArangoDB)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `ix-cli/src/cli/commands/depends.ts` | Modify | Add REFERENCES expand + `referenced_by` relation |
| `ix-cli/src/cli/commands/callers.ts` | Modify | Add REFERENCES to expandByName predicates |
| `ix-cli/src/cli/commands/overview.ts` | Modify | Add REFERENCES to inbound queries |
| `ix-cli/src/cli/commands/impact.ts` | Modify | Add REFERENCES to dependents + member queries |
| `ix-cli/src/cli/commands/rank.ts` | Modify | Add REFERENCES to `dependents` metric config |
| `ix-cli/src/cli/commands/locate.ts` | Modify | Add REFERENCES expand + `referenced-by` relationship |
| `memory-layer/src/test/resources/fixtures/command_registration.ts` | Create | TS fixture: main.ts-style imports with .js extensions |
| `memory-layer/src/test/resources/fixtures/command_module.ts` | Create | TS fixture: explain.ts-style export |
| `memory-layer/src/test/resources/fixtures/node_kind.scala` | Create | Scala fixture: sealed trait + companion with case objects |
| `memory-layer/src/test/resources/fixtures/node_kind_user.scala` | Create | Scala fixture: class using NodeKind in signatures + bodies |
| `memory-layer/src/test/scala/ix/memory/QueryUsefulnessSpec.scala` | Create | ArangoDB integration tests |

---

### Task 1: Add REFERENCES to `depends.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/depends.ts:10-16,49-52,56,86-87`

The `depends` command does two parallel expands (CALLS inbound, IMPORTS inbound). Add a third for REFERENCES inbound.

- [ ] **Step 1: Update DependencyNode type**

In `ix-cli/src/cli/commands/depends.ts`, update the `DependencyNode` interface (lines 15-16):

```typescript
// Before:
  relation: "called_by" | "imported_by";
  sourceEdge: "CALLS" | "IMPORTS";

// After:
  relation: "called_by" | "imported_by" | "referenced_by";
  sourceEdge: "CALLS" | "IMPORTS" | "REFERENCES";
```

- [ ] **Step 2: Widen processNodes inline parameter types**

The `processNodes` inner function (line 56) has inline type unions that must be widened to include the new values:

```typescript
// Before:
    const processNodes = async (nodes: any[], relation: "called_by" | "imported_by", sourceEdge: "CALLS" | "IMPORTS") => {

// After:
    const processNodes = async (nodes: any[], relation: "called_by" | "imported_by" | "referenced_by", sourceEdge: "CALLS" | "IMPORTS" | "REFERENCES") => {
```

- [ ] **Step 3: Add REFERENCES expand call**

In `buildDependencyTree` function (lines 49-52), add a third parallel expand:

```typescript
// Before:
    const [callResult, importResult] = await Promise.all([
      client.expand(nodeId, { direction: "in", predicates: ["CALLS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["IMPORTS"], hops: 1 }),
    ]);

// After:
    const [callResult, importResult, refResult] = await Promise.all([
      client.expand(nodeId, { direction: "in", predicates: ["CALLS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["IMPORTS"], hops: 1 }),
      client.expand(nodeId, { direction: "in", predicates: ["REFERENCES"], hops: 1 }),
    ]);
```

- [ ] **Step 4: Process REFERENCES results**

After line 87 (`await processNodes(importResult.nodes, "imported_by", "IMPORTS");`), add:

```typescript
    await processNodes(refResult.nodes, "referenced_by", "REFERENCES");
```

- [ ] **Step 5: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/depends.ts
git commit -m "feat: add REFERENCES to depends command predicate list"
```

---

### Task 2: Add REFERENCES to `callers.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/callers.ts:30-33`

The `callers` command uses `expandByName` with `["CALLS"]`. Add `"REFERENCES"` so that type/value references also show up as callers.

- [ ] **Step 1: Update callers predicates**

In `ix-cli/src/cli/commands/callers.ts` line 32, update:

```typescript
// Before:
      const result = await client.expandByName(target.name, {
        direction: "in",
        predicates: ["CALLS"],
        kinds: ["function", "method"],
      });

// After:
      const result = await client.expandByName(target.name, {
        direction: "in",
        predicates: ["CALLS", "REFERENCES"],
        kinds: ["function", "method"],
      });
```

- [ ] **Step 2: Update diagnostic message**

In line 79, update the text fallback diagnostic to mention REFERENCES:

```typescript
// Before:
                  message: "No graph-backed CALLS edges found. If files were ingested before CALLS extraction was added, run: ix ingest --force --recursive .",

// After:
                  message: "No graph-backed CALLS/REFERENCES edges found. If files were ingested before extraction was added, run: ix ingest --force --recursive .",
```

Also update line 83:
```typescript
// Before:
              stderr(chalk.dim("No graph-backed CALLS edges found. Showing text-based candidate usages."));

// After:
              stderr(chalk.dim("No graph-backed CALLS/REFERENCES edges found. Showing text-based candidate usages."));
```

- [ ] **Step 3: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/callers.ts
git commit -m "feat: add REFERENCES to callers command predicate list"
```

---

### Task 3: Add REFERENCES to `overview.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/overview.ts:88,135-137,228-229,262-263`

The `overview` command has two paths: container (file/class/object) and callable (function/method). Both need REFERENCES.

- [ ] **Step 1: Update container overview — inbound dependents**

In `overviewContainer` (line 88), add REFERENCES to the inbound query:

```typescript
// Before:
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "IMPORTS"] }),

// After:
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] }),
```

- [ ] **Step 2: Update container overview — member caller counts**

In `overviewContainer` (lines 135-137), add REFERENCES to member caller count queries:

```typescript
// Before:
          const callersResult = await client.expand(m.id, {
            direction: "in",
            predicates: ["CALLS"],
          });

// After:
          const callersResult = await client.expand(m.id, {
            direction: "in",
            predicates: ["CALLS", "REFERENCES"],
          });
```

- [ ] **Step 3: Update callable overview — callers and callees**

In `overviewCallable` (lines 228-229), add REFERENCES:

```typescript
// Before:
    client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),

// After:
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"] }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS", "REFERENCES"] }),
```

- [ ] **Step 4: Update callable overview — empty diagnostic**

In `overviewCallable` (lines 262-263), update the diagnostic message:

```typescript
// Before:
    diagnostics.push("No CALLS edges found. If files were ingested before CALLS extraction, run: ix ingest --force --recursive .");

// After:
    diagnostics.push("No CALLS/REFERENCES edges found. If files were ingested before extraction was added, run: ix ingest --force --recursive .");
```

- [ ] **Step 5: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add ix-cli/src/cli/commands/overview.ts
git commit -m "feat: add REFERENCES to overview command predicate lists"
```

---

### Task 4: Add REFERENCES to `impact.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/impact.ts:58,84-86,197-198`

- [ ] **Step 1: Update container impact — direct dependents**

In `containerImpact` (line 58), add REFERENCES:

```typescript
// Before:
    client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),

// After:
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"] }),
```

- [ ] **Step 2: Update container impact — member caller counts**

In `containerImpact` (lines 84-86), add REFERENCES:

```typescript
// Before:
      const callersResult = await client.expand(member.id, {
        direction: "in",
        predicates: ["CALLS"],
      });

// After:
      const callersResult = await client.expand(member.id, {
        direction: "in",
        predicates: ["CALLS", "REFERENCES"],
      });
```

- [ ] **Step 3: Update leaf impact — callers and callees**

In `leafImpact` (lines 197-198), add REFERENCES:

```typescript
// Before:
    client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),

// After:
    client.expand(target.id, { direction: "in", predicates: ["CALLS", "REFERENCES"] }),
    client.expand(target.id, { direction: "out", predicates: ["CALLS", "REFERENCES"] }),
```

- [ ] **Step 4: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ix-cli/src/cli/commands/impact.ts
git commit -m "feat: add REFERENCES to impact command predicate lists"
```

---

### Task 5: Add REFERENCES to `rank.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/rank.ts:8-13`

- [ ] **Step 1: Update METRIC_CONFIG**

In `ix-cli/src/cli/commands/rank.ts` (lines 8-13), add REFERENCES to the `dependents` and `callers` metrics:

```typescript
// Before:
const METRIC_CONFIG: Record<Metric, { direction: string; predicates: string[] }> = {
  dependents: { direction: "in", predicates: ["CALLS", "IMPORTS"] },
  callers: { direction: "in", predicates: ["CALLS"] },
  importers: { direction: "in", predicates: ["IMPORTS"] },
  members: { direction: "out", predicates: ["CONTAINS"] },
};

// After:
const METRIC_CONFIG: Record<Metric, { direction: string; predicates: string[] }> = {
  dependents: { direction: "in", predicates: ["CALLS", "IMPORTS", "REFERENCES"] },
  callers: { direction: "in", predicates: ["CALLS", "REFERENCES"] },
  importers: { direction: "in", predicates: ["IMPORTS"] },
  members: { direction: "out", predicates: ["CONTAINS"] },
};
```

- [ ] **Step 2: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/rank.ts
git commit -m "feat: add REFERENCES to rank command metric config"
```

---

### Task 6: Add REFERENCES to `locate.ts`

**Files:**
- Modify: `ix-cli/src/cli/commands/locate.ts:15-20,90-106,142-156`

- [ ] **Step 1: Update RelatedItem type**

In `ix-cli/src/cli/commands/locate.ts` (line 19), add `referenced-by`:

```typescript
// Before:
  relationship: "contains" | "contained-by" | "depends-on" | "imported-by" | "calls" | "called-by";

// After:
  relationship: "contains" | "contained-by" | "depends-on" | "imported-by" | "calls" | "called-by" | "referenced-by";
```

- [ ] **Step 2: Add REFERENCES expand call**

In the parallel expand block (lines 90-106), add a REFERENCES expand:

```typescript
// Before:
      const [
        details,
        containsResult,
        callersResult,
        calleesResult,
        importsResult,
        importedByResult,
      ] = await Promise.all([
        client.entity(target.id),
        isContainer
          ? client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] })
          : client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
        client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] }),
        client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] }),
      ]);

// After:
      const [
        details,
        containsResult,
        callersResult,
        calleesResult,
        importsResult,
        importedByResult,
        referencedByResult,
      ] = await Promise.all([
        client.entity(target.id),
        isContainer
          ? client.expand(target.id, { direction: "out", predicates: ["CONTAINS"] })
          : client.expand(target.id, { direction: "in", predicates: ["CONTAINS"] }),
        client.expand(target.id, { direction: "in", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["CALLS"] }),
        client.expand(target.id, { direction: "out", predicates: ["IMPORTS"] }),
        client.expand(target.id, { direction: "in", predicates: ["IMPORTS"] }),
        client.expand(target.id, { direction: "in", predicates: ["REFERENCES"] }),
      ]);
```

- [ ] **Step 3: Process REFERENCES results into relationships**

After the `importedByResult` loop (after line 156), add:

```typescript
      for (const n of referencedByResult.nodes) {
        relationships.push(nodeToRelated(n, "referenced-by"));
      }
```

- [ ] **Step 4: Verify CLI builds**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add ix-cli/src/cli/commands/locate.ts
git commit -m "feat: add REFERENCES to locate command"
```

---

### Task 7: Create test fixtures

**Files:**
- Create: `memory-layer/src/test/resources/fixtures/command_registration.ts`
- Create: `memory-layer/src/test/resources/fixtures/command_module.ts`
- Create: `memory-layer/src/test/resources/fixtures/node_kind.scala`
- Create: `memory-layer/src/test/resources/fixtures/node_kind_user.scala`

- [ ] **Step 1: Create TS command registration fixture**

Create `memory-layer/src/test/resources/fixtures/command_registration.ts`:

```typescript
import { Command } from "commander";
import { registerExplainCommand } from "./commands/command_module.js";

const program = new Command();
program.name("test-cli").version("0.1.0");

registerExplainCommand(program);

program.parse();
```

- [ ] **Step 2: Create TS command module fixture**

Create `memory-layer/src/test/resources/fixtures/command_module.ts`:

```typescript
import type { Command } from "commander";

export function registerExplainCommand(program: Command): void {
  program
    .command("explain <symbol>")
    .description("Explain an entity")
    .action(async (symbol: string) => {
      const result = await resolveEntity(symbol);
      console.log(result);
    });
}

async function resolveEntity(symbol: string): Promise<string> {
  return `Resolved: ${symbol}`;
}
```

- [ ] **Step 3: Create Scala NodeKind fixture**

Create `memory-layer/src/test/resources/fixtures/node_kind.scala`:

```scala
package ix.memory.model

sealed trait NodeKind

object NodeKind {
  case object File extends NodeKind
  case object Module extends NodeKind
  case object Class extends NodeKind
  case object Function extends NodeKind
  case object Method extends NodeKind
}
```

- [ ] **Step 4: Create Scala NodeKind user fixture**

Create `memory-layer/src/test/resources/fixtures/node_kind_user.scala`:

```scala
package ix.memory.ingestion

class GraphPatchBuilder {
  def buildNode(kind: NodeKind, name: String): GraphNode = {
    val effectiveKind = NodeKind.File
    val result = createNode(name, effectiveKind)
    result
  }

  private def createNode(name: String, kind: NodeKind): GraphNode = {
    GraphNode(name, kind)
  }
}
```

- [ ] **Step 5: Commit**

```bash
git add memory-layer/src/test/resources/fixtures/command_registration.ts \
        memory-layer/src/test/resources/fixtures/command_module.ts \
        memory-layer/src/test/resources/fixtures/node_kind.scala \
        memory-layer/src/test/resources/fixtures/node_kind_user.scala
git commit -m "test: add fixtures for query usefulness integration tests"
```

---

### Task 8: Create integration tests

**Files:**
- Create: `memory-layer/src/test/scala/ix/memory/QueryUsefulnessSpec.scala`

These tests require a running ArangoDB instance. They follow the same pattern as `EndToEndSpec.scala`.

- [ ] **Step 1: Write the integration test file**

Create `memory-layer/src/test/scala/ix/memory/QueryUsefulnessSpec.scala`:

```scala
package ix.memory

import java.nio.file.{Path, Paths}

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.db._
import ix.memory.ingestion.{IngestionService, ParserRouter}
import ix.memory.model._

/**
 * Integration tests verifying that parser-emitted edges (especially REFERENCES)
 * are persisted and queryable via the expand API.
 *
 * Requires a running ArangoDB instance on localhost:8529.
 */
class QueryUsefulnessSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers with TestDbHelper {

  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_memory_test", user = "root", password = ""
  )

  private def fixturePath(name: String): Path = {
    val url = getClass.getClassLoader.getResource(s"fixtures/$name")
    Paths.get(url.toURI)
  }

  // ── Scala REFERENCES: object references become query-useful ──

  "QueryUsefulness" should "persist REFERENCES edges from Scala parser and return them via expand" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- cleanDatabase(client)
        // Ingest the NodeKind fixture (defines sealed trait + companion with case objects)
        _ <- service.ingestFile(fixturePath("node_kind.scala"))
        // Ingest the user fixture (uses NodeKind in signatures and bodies)
        _ <- service.ingestFile(fixturePath("node_kind_user.scala"))

        // Search for NodeKind entity
        nodeKindResults <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindEntity = nodeKindResults.find(n => n.name == "NodeKind" && n.kind != NodeKind.Module)

        _ = nodeKindEntity shouldBe defined

        // Expand inbound REFERENCES edges to NodeKind
        refResult <- queryApi.expand(
          nodeKindEntity.get.id,
          Direction.In,
          predicates = Some(Set("REFERENCES")),
          hops = 1
        )

        // Should have at least one REFERENCES edge (from buildNode or createNode)
        _ = refResult.nodes should not be empty
        refNames = refResult.nodes.map(_.name)
        _ = refNames should contain atLeastOneOf ("buildNode", "createNode")
      } yield succeed
    }
  }

  it should "return REFERENCES edges alongside CALLS in combined dependency queries" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- cleanDatabase(client)
        _ <- service.ingestFile(fixturePath("node_kind.scala"))
        _ <- service.ingestFile(fixturePath("node_kind_user.scala"))

        nodeKindResults <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindEntity = nodeKindResults.find(n => n.name == "NodeKind" && n.kind != NodeKind.Module)
        _ = nodeKindEntity shouldBe defined

        // Combined query: CALLS + IMPORTS + REFERENCES (what `depends` now uses)
        combinedResult <- queryApi.expand(
          nodeKindEntity.get.id,
          Direction.In,
          predicates = Some(Set("CALLS", "IMPORTS", "REFERENCES")),
          hops = 1
        )

        // Should include REFERENCES-backed dependents
        _ = combinedResult.nodes should not be empty
      } yield succeed
    }
  }

  // ── Scala nested CONTAINS: object membership is queryable ──

  it should "persist nested CONTAINS edges for case objects inside companion" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- cleanDatabase(client)
        _ <- service.ingestFile(fixturePath("node_kind.scala"))

        // Find the NodeKind object entity
        results <- queryApi.searchNodes("NodeKind", limit = 10, nameOnly = true)
        nodeKindObj = results.find(n => n.name == "NodeKind" && n.kind == NodeKind.Object)
        _ = nodeKindObj shouldBe defined

        // Expand CONTAINS — should show case object members
        containsResult <- queryApi.expand(
          nodeKindObj.get.id,
          Direction.Out,
          predicates = Some(Set("CONTAINS")),
          hops = 1
        )

        memberNames = containsResult.nodes.map(_.name)
        _ = memberNames should contain allOf ("File", "Module", "Class", "Function", "Method")
      } yield succeed
    }
  }

  // ── TypeScript: file-level CALLS correctness ──

  it should "not create false file-level CALLS for exported function definitions" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- cleanDatabase(client)
        _ <- service.ingestFile(fixturePath("command_module.ts"))

        // Find the file entity
        fileResults <- queryApi.searchNodes("command_module.ts", limit = 5, nameOnly = true)
        fileEntity = fileResults.find(n => n.name == "command_module.ts" && n.kind == NodeKind.File)
        _ = fileEntity shouldBe defined

        // File-level CALLS should not include registerExplainCommand (it's a definition, not a call)
        callsResult <- queryApi.expand(
          fileEntity.get.id,
          Direction.Out,
          predicates = Some(Set("CALLS")),
          hops = 1
        )

        calleeNames = callsResult.nodes.map(_.name)
        _ = calleeNames should not contain ("registerExplainCommand")
      } yield succeed
    }
  }

  // ── TypeScript: cross-file caller attribution ──

  it should "create cross-file CALLS edges for imported function invocations" in {
    clientResource.use { client =>
      val writeApi = new ArangoGraphWriteApi(client)
      val queryApi = new ArangoGraphQueryApi(client)
      val router   = new ParserRouter()
      val service  = new IngestionService(router, writeApi, queryApi)

      for {
        _ <- cleanDatabase(client)
        // Ingest command_module first (defines registerExplainCommand)
        _ <- service.ingestFile(fixturePath("command_module.ts"))
        // Then command_registration (imports and calls registerExplainCommand)
        _ <- service.ingestFile(fixturePath("command_registration.ts"))

        // Find registerExplainCommand function entity
        funcResults <- queryApi.searchNodes("registerExplainCommand", limit = 10, nameOnly = true)
        funcEntity = funcResults.find(n => n.name == "registerExplainCommand" && n.kind == NodeKind.Function)
        _ = funcEntity shouldBe defined

        // Expand inbound CALLS — should include command_registration.ts (file-level call)
        callersResult <- queryApi.expand(
          funcEntity.get.id,
          Direction.In,
          predicates = Some(Set("CALLS")),
          hops = 1
        )

        callerNames = callersResult.nodes.map(_.name)
        // command_registration.ts should call registerExplainCommand at file level
        _ = callerNames should contain ("command_registration.ts")
        // command_module.ts should NOT be a caller (it defines it)
        _ = callerNames should not contain ("command_module.ts")
      } yield succeed
    }
  }
}
```

- [ ] **Step 2: Verify the test compiles**

The test uses:
- `TestDbHelper` trait (at `memory-layer/src/test/scala/ix/memory/TestDbHelper.scala`) — provides `cleanDatabase(client: ArangoClient): IO[Unit]`
- `Direction.In` / `Direction.Out` — from `ix.memory.db.Direction` (imported via `ix.memory.db._`)
- `queryApi.expand(nodeId: NodeId, direction: Direction, predicates: Option[Set[String]], hops: Int)` — standard API

Run: `sbt "Test / compile"`
Expected: Compiles without errors

- [ ] **Step 3: Run integration tests (requires ArangoDB)**

Run: `sbt "testOnly *QueryUsefulnessSpec"`

Expected: All 5 tests pass (if ArangoDB is running). If ArangoDB is not running, tests will fail with connection errors — this is expected for CI environments without ArangoDB.

- [ ] **Step 4: Commit**

```bash
git add memory-layer/src/test/scala/ix/memory/QueryUsefulnessSpec.scala
git commit -m "test: add integration tests for REFERENCES query usefulness"
```

---

### Task 9: Build CLI and verify

- [ ] **Step 1: Build CLI**

Run: `cd ix-cli && npx tsc --noEmit`
Expected: No type errors

- [ ] **Step 2: Run existing CLI tests**

Run: `cd ix-cli && npx vitest run`
Expected: All existing tests pass

- [ ] **Step 3: Run parser unit tests**

Run: `sbt "testOnly *TypeScriptParserSpec" "testOnly *ScalaParserSpec"`
Expected: All 71 tests pass (unchanged from previous patch)

- [ ] **Step 4: Final commit (if any adjustments needed)**

```bash
git add -A
git commit -m "chore: final build verification"
```

---

## Verification (post-deploy)

After deploying the backend and rebuilding the CLI, re-ingest and verify:

```bash
# Re-ingest
ix ingest ix-cli/src/cli/ --recursive
ix ingest memory-layer/src/main/scala/ix/memory/model/ --recursive

# TS source-file queries
ix depends explain.ts --format json          # Should show dependents
ix imported-by explain.ts --format json      # Should show main.ts
ix callers registerExplainCommand --format json  # Should show main.ts caller

# Scala object queries
ix overview NodeKind --format json           # Should show members + inbound dependents
ix depends NodeKind --format json            # Should show REFERENCES-backed deps
ix callers NodeKind --format json            # Should show functions referencing NodeKind
```
