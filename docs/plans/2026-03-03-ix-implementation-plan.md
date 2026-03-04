# Ix Memory Layer Redesign — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Adapt the existing Scala Memory Layer (remove tenant, add Intent/Decision nodes, fix UpsertNode versioning, add parser-generated claims, update pipeline to 8 steps) and build a new TypeScript CLI + MCP server.

**Architecture:** Phase 1 modifies existing Scala codebase (48 files). Phase 2 creates new TypeScript package. Both talk to ArangoDB via Docker. Design spec: `docs/plans/2026-03-03-ix-redesign.md`.

**Tech Stack:**
- **Phase 1:** Scala 2.13, Cats Effect 3, http4s 0.23, Circe 0.14, ArangoDB 7.12
- **Phase 2:** TypeScript, commander.js, @modelcontextprotocol/sdk, node-fetch

---

## Phase 1: Adapt Memory Layer (Scala)

### Task 1: Remove TenantId from Model Classes

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/model/Identifiers.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/model/Node.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/model/Edge.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/model/GraphPatch.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ModelSpec.scala`

**Step 1: Write the failing test**

In `ModelSpec.scala`, add a test that creates a `GraphNode` without tenant:

```scala
"GraphNode" should "not require TenantId" in {
  val node = GraphNode(
    id = NodeId(UUID.randomUUID()),
    kind = NodeKind.Function,
    attrs = Json.obj("name" -> "retry".asJson),
    provenance = testProvenance,
    createdRev = Rev(1L),
    deletedRev = None,
    createdAt = Instant.now(),
    updatedAt = Instant.now()
  )
  node.kind shouldBe NodeKind.Function
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.ModelSpec"`
Expected: FAIL — `GraphNode` still requires `tenant` parameter

**Step 3: Remove TenantId from models**

In `Identifiers.scala` — delete lines 7-11 (the full `TenantId` case class, object, encoder, decoder). Keep all other identifiers.

In `Node.scala` — remove `tenant: TenantId` from `GraphNode` case class (line 52). Update encoder/decoder.

In `Edge.scala` — remove `tenant: TenantId` from `GraphEdge` case class (line 17). Update encoder/decoder.

In `GraphPatch.scala` — remove `tenant: TenantId` from `GraphPatch` case class (line 76). Remove comment on line 137 about tenant. Update encoder/decoder.

**Step 4: Fix all compilation errors**

Every file that imports or references `TenantId` will fail to compile. Fix each one by removing the `tenant` parameter. This touches ~25 files. For each file:
- Remove `import ix.memory.model.TenantId` (or from wildcard import)
- Remove `tenant` parameters from method signatures
- Remove `tenant` from AQL query bind variables
- Remove `"tenant" ->` from JSON objects being sent to ArangoDB

Key files to update:
- `db/GraphQueryApi.scala` — remove tenant from all 7 method signatures
- `db/ArangoGraphQueryApi.scala` — remove tenant from all methods + AQL queries
- `db/ArangoGraphWriteApi.scala` — remove tenant from commit path
- `context/ContextService.scala` — remove tenant from `query()`
- `context/GraphSeeder.scala` — remove tenant from `seed()`
- `context/GraphExpander.scala` — remove tenant from `expand()`
- `context/ClaimCollector.scala` — remove tenant from `collect()`
- `conflict/ConflictService.scala` — remove tenant from all 4 methods
- `ingestion/IngestionService.scala` — remove tenant from `ingestFile()` and `ingestPath()`
- `ingestion/GraphPatchBuilder.scala` — remove tenant from `build()`, update deterministic ID: change `s"${tenant.value}:$filePath:$name"` to `s"$filePath:$name"`
- `api/ContextRoutes.scala` — remove tenant from request parsing
- `api/IngestionRoutes.scala` — remove tenant from request parsing
- `api/EntityRoutes.scala` — remove tenant from query params
- `api/DiffRoutes.scala` — remove tenant from request parsing
- `api/ConflictRoutes.scala` — remove tenant from query params

**Step 5: Run all tests to verify compilation**

Run: `cd memory-layer && sbt compile`
Expected: PASS (compiles with no tenant references)

**Step 6: Update all existing tests**

Update every test file to remove `TenantId` usage:
- `ModelSpec.scala` — remove TenantId from test data
- `GraphWriteApiSpec.scala` — remove tenant from test patches
- `GraphQueryApiSpec.scala` — remove tenant from queries
- `ContextServiceSpec.scala` — remove tenant from test calls
- `EndToEndSpec.scala` — remove tenant from all 4 tests
- `RoutesSpec.scala` — remove tenant from request bodies/query params
- `ConflictDetectorSpec.scala` — remove tenant references
- `ConfidenceScorerSpec.scala` — remove tenant references

**Step 7: Run all tests**

Run: `cd memory-layer && sbt test`
Expected: All tests PASS (some may fail due to ArangoDB schema needing updates — that's Task 3)

**Step 8: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: remove TenantId from all models and APIs (single-codebase system)"
```

---

### Task 2: Add Intent, Decision Node Kinds and FULFILLS Edge

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/model/Node.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/model/StructuredContext.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ModelSpec.scala`

**Step 1: Write the failing test**

```scala
"NodeKind" should "include Intent and Decision" in {
  NodeKind.fromString("Intent") shouldBe Some(NodeKind.Intent)
  NodeKind.fromString("Decision") shouldBe Some(NodeKind.Decision)
  NodeKind.Intent.baseAuthority shouldBe 0.85
  NodeKind.Decision.baseAuthority shouldBe 0.85
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.ModelSpec"`
Expected: FAIL — NodeKind.Intent does not exist

**Step 3: Add Intent and Decision to NodeKind**

In `Node.scala`, add to the `NodeKind` sealed trait:

```scala
case object Intent extends NodeKind
case object Decision extends NodeKind
```

Update `baseAuthority()` method to include:
```scala
case Intent   => 0.85
case Decision => 0.85
```

Update `fromString()` and the Circe encoder/decoder to handle `"Intent"` and `"Decision"`.

**Step 4: Update StructuredContext**

In `StructuredContext.scala`, add:

```scala
final case class DecisionReport(
  title: String,
  rationale: String,
  entityId: Option[NodeId],
  intentId: Option[NodeId],
  rev: Rev
)

final case class IntentReport(
  id: NodeId,
  statement: String,
  status: String,
  confidence: Double,
  parentIntent: Option[String]
)
```

Update `StructuredContext` to include:
```scala
final case class StructuredContext(
  claims: Vector[ScoredClaim],
  conflicts: Vector[ConflictReport],
  decisions: Vector[DecisionReport],
  intents: Vector[IntentReport],
  nodes: Vector[GraphNode],
  edges: Vector[GraphEdge],
  metadata: ContextMetadata
)
```

Add `depth: Option[String]` to `ContextMetadata`.

Add Circe encoders/decoders for new types.

**Step 5: Run tests**

Run: `cd memory-layer && sbt "testOnly ix.memory.ModelSpec"`
Expected: PASS

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/model/
git commit -m "feat: add Intent, Decision node kinds and update StructuredContext"
```

---

### Task 3: Update ArangoDB Schema (Remove Tenant Indexes)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ArangoClientSpec.scala`

**Step 1: Write the failing test**

```scala
"ensureSchema" should "create schema without tenant indexes" in {
  clientResource.use { client =>
    for {
      _ <- client.ensureSchema()
      // Verify nodes collection exists
      result <- client.query("RETURN LENGTH(nodes)", Map.empty)
    } yield {
      result should not be empty
    }
  }
}
```

**Step 2: Run test to verify current state**

Run: `cd memory-layer && sbt "testOnly ix.memory.ArangoClientSpec"`

**Step 3: Update ArangoSchema**

In `ArangoSchema.scala`, update `ensure()` method:
- Remove all `"tenant"` fields from index definitions
- Change index on nodes from `["tenant", "kind"]` to `["kind"]`
- Change index on nodes from `["tenant", "name"]` to `["name"]` (fulltext)
- Change index on edges from `["tenant", "src"]` to `["src"]`
- Change index on edges from `["tenant", "dst"]` to `["dst"]`
- Change index on claims from `["tenant", "entity_id"]` to `["entity_id"]`
- Change index on claims from `["tenant", "status"]` to `["status"]`
- Change index on patches from `["tenant", "patch_id"]` to `["patch_id"]`
- Change revisions key from tenant-based to a single `"current"` key
- Add index on claims for `["statement"]` (fulltext, for claim-based search)
- Add index on patches for `["source_uri", "extractor"]` (for replaces discovery)

**Step 4: Run test**

Run: `cd memory-layer && sbt "testOnly ix.memory.ArangoClientSpec"`
Expected: PASS

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala
git commit -m "feat: update ArangoDB schema — remove tenant indexes, add claim/patch indexes"
```

---

### Task 4: Fix UpsertNode Versioning (Tombstone + New Row)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphWriteApi.scala`
- Test: `memory-layer/src/test/scala/ix/memory/GraphWriteApiSpec.scala`

**Step 1: Write the failing test**

```scala
"UpsertNode" should "version node when attrs change (tombstone old, create new)" in {
  clientResource.use { client =>
    val writeApi = new ArangoGraphWriteApi(client)
    val queryApi = new ArangoGraphQueryApi(client)
    val nodeId = NodeId(UUID.randomUUID())

    val patch1 = makePatch(ops = Vector(
      PatchOp.UpsertNode(nodeId, NodeKind.Function, "retry", Map("max_retries" -> Json.fromInt(3)))
    ))
    val patch2 = makePatch(baseRev = Rev(1L), ops = Vector(
      PatchOp.UpsertNode(nodeId, NodeKind.Function, "retry", Map("max_retries" -> Json.fromInt(5)))
    ))

    for {
      _       <- client.ensureSchema()
      commit1 <- writeApi.commitPatch(patch1)
      commit2 <- writeApi.commitPatch(patch2)
      // Query at rev 1 should see max_retries=3
      nodeAtRev1 <- queryApi.getNode(nodeId, asOfRev = Some(commit1.newRev))
      // Query at rev 2 should see max_retries=5
      nodeAtRev2 <- queryApi.getNode(nodeId, asOfRev = Some(commit2.newRev))
    } yield {
      nodeAtRev1 shouldBe defined
      nodeAtRev1.get.attrs.hcursor.get[Int]("max_retries").toOption shouldBe Some(3)

      nodeAtRev2 shouldBe defined
      nodeAtRev2.get.attrs.hcursor.get[Int]("max_retries").toOption shouldBe Some(5)
    }
  }
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.GraphWriteApiSpec"`
Expected: FAIL — nodeAtRev1 returns max_retries=5 (current behavior overwrites attrs)

**Step 3: Update ArangoGraphWriteApi UpsertNode handler**

In `ArangoGraphWriteApi.scala`, modify the `executeOp` case for `UpsertNode` (currently ~lines 100-140):

```scala
case PatchOp.UpsertNode(id, kind, name, attrs) =>
  val logicalId = id.value.toString
  // Check if node exists at current state
  val checkAql = """
    FOR n IN nodes
      FILTER n._key LIKE CONCAT(@logicalId, "%")
      AND n.deleted_rev == null
      RETURN n
  """
  for {
    existing <- client.queryOne(checkAql, Map("logicalId" -> logicalId), txId)
    _ <- existing match {
      case Some(existingJson) =>
        // Node exists — check if attrs changed
        val existingAttrs = existingJson.hcursor.get[Json]("attrs").getOrElse(Json.Null)
        val newAttrsJson = attrsToJson(attrs)
        if (existingAttrs == newAttrsJson) {
          // Same attrs — idempotent no-op
          IO.unit
        } else {
          // Different attrs — tombstone old row + create new row
          val existingKey = existingJson.hcursor.get[String]("_key").getOrElse(logicalId)
          val tombstoneAql = """
            UPDATE { _key: @key } WITH { deleted_rev: @rev } IN nodes
              OPTIONS { waitForSync: true }
          """
          val newKey = s"${logicalId}_${newRev.value}"
          val insertAql = """
            INSERT {
              _key: @key, logical_id: @logicalId, kind: @kind, name: @name,
              attrs: @attrs, provenance: @prov,
              created_rev: @rev, deleted_rev: null,
              created_at: @now, updated_at: @now
            } INTO nodes OPTIONS { waitForSync: true }
          """
          for {
            _ <- client.execute(tombstoneAql, Map("key" -> existingKey, "rev" -> newRev.value), txId)
            _ <- client.execute(insertAql, Map(
              "key" -> newKey, "logicalId" -> logicalId,
              "kind" -> kind.toString, "name" -> name,
              "attrs" -> newAttrsJson, "prov" -> provenanceJson,
              "rev" -> newRev.value, "now" -> Instant.now().toString
            ), txId)
          } yield ()
        }

      case None =>
        // New node — create first row
        val newKey = s"${logicalId}_${newRev.value}"
        val insertAql = """
          INSERT {
            _key: @key, logical_id: @logicalId, kind: @kind, name: @name,
            attrs: @attrs, provenance: @prov,
            created_rev: @rev, deleted_rev: null,
            created_at: @now, updated_at: @now
          } INTO nodes OPTIONS { waitForSync: true }
        """
        client.execute(insertAql, Map(
          "key" -> newKey, "logicalId" -> logicalId,
          "kind" -> kind.toString, "name" -> name,
          "attrs" -> attrsToJson(attrs), "prov" -> provenanceJson,
          "rev" -> newRev.value, "now" -> Instant.now().toString
        ), txId)
    }
  } yield ()
```

**Step 4: Update ArangoGraphQueryApi to use logical_id**

In `ArangoGraphQueryApi.scala`, update `getNode()` to filter by `logical_id` and MVCC:

```scala
def getNode(id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]] = {
  val rev = asOfRev.getOrElse(/* latest */)
  val aql = """
    FOR n IN nodes
      FILTER n.logical_id == @id
      AND n.created_rev <= @rev
      AND (n.deleted_rev == null OR @rev < n.deleted_rev)
      RETURN n
  """
  client.queryOne(aql, Map("id" -> id.value.toString, "rev" -> rev.value))
    .map(_.flatMap(parseNode))
}
```

Update all other query methods similarly — use `logical_id` instead of `_key` for node lookups.

**Step 5: Run test**

Run: `cd memory-layer && sbt "testOnly ix.memory.GraphWriteApiSpec"`
Expected: PASS — time-travel returns correct attrs at each revision

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/
git commit -m "feat: UpsertNode versioning — tombstone old row, create new row for attr changes"
```

---

### Task 5: Add Parser-Generated Claims to Ingestion

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/ingestion/GraphPatchBuilder.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/ingestion/ParseResult.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ingestion/TreeSitterPythonParserSpec.scala`

**Step 1: Write the failing test**

```scala
"GraphPatchBuilder" should "generate claims from parsed entities" in {
  val parseResult = ParseResult(
    entities = Vector(
      ParsedEntity("BillingService", NodeKind.Class, Map.empty, Some(3), Some(10)),
      ParsedEntity("retry_payment", NodeKind.Function,
        Map("signature" -> "retry_payment(self, amount, max_retries=3)"),
        Some(4), Some(9))
    ),
    relationships = Vector(
      ParsedRelationship("BillingService", "retry_payment", "DEFINES")
    )
  )

  val builder = new GraphPatchBuilder("billing_service.py", "abc123")
  val patch = builder.build(parseResult)

  val assertOps = patch.ops.collect { case a: PatchOp.AssertClaim => a }
  assertOps should not be empty
  assertOps.exists(_.statement == "defines_method:retry_payment") shouldBe true
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly *TreeSitterPythonParserSpec"`
Expected: FAIL — no AssertClaim ops generated

**Step 3: Update GraphPatchBuilder to generate claims**

In `GraphPatchBuilder.scala`, add claim generation after node/edge ops:

```scala
// After building UpsertNode and UpsertEdge ops, add claims:
val claimOps: Vector[PatchOp] = relationships.flatMap { rel =>
  val srcId = nodeIdFor(rel.srcName)
  Vector(
    PatchOp.AssertClaim(srcId, s"${rel.predicate.toLowerCase}:${rel.dstName}",
      Json.fromString(rel.dstName), None)
  )
} ++ entities.flatMap { entity =>
  val entityId = nodeIdFor(entity.name)
  // Generate claims from attrs (e.g., signature → parameter defaults)
  entity.attrs.flatMap { case (key, value) =>
    Vector(PatchOp.AssertClaim(entityId, s"$key", Json.fromString(value), None))
  }.toVector
}

// Combine: nodes + edges + claims
val allOps = nodeOps ++ edgeOps ++ claimOps
```

**Step 4: Run test**

Run: `cd memory-layer && sbt "testOnly *TreeSitterPythonParserSpec"`
Expected: PASS

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/ingestion/
git commit -m "feat: parsers now generate claims alongside nodes and edges"
```

---

### Task 6: Add Replaces Discovery Mechanism

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/ingestion/IngestionService.scala`
- Test: `memory-layer/src/test/scala/ix/memory/EndToEndSpec.scala`

**Step 1: Write the failing test**

```scala
"IngestionService" should "set replaces when re-ingesting a changed file" in {
  clientResource.use { client =>
    val writeApi = new ArangoGraphWriteApi(client)
    val queryApi = new ArangoGraphQueryApi(client)
    val parserRouter = new ParserRouter()
    val ingestion = new IngestionService(parserRouter, writeApi, queryApi)

    for {
      _ <- client.ensureSchema()
      commit1 <- ingestion.ingestFile(fixtureFilePath)
      // Modify file content hash simulation — re-ingest
      commit2 <- ingestion.ingestFile(fixtureFilePath)
      // Get patches for the file
      patches <- queryApi.getPatchesBySource("billing_service.py", "tree-sitter-python")
    } yield {
      patches.size should be >= 1
      // Second ingestion should either be idempotent (same hash) or have replaces set
    }
  }
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.EndToEndSpec"`
Expected: FAIL — `getPatchesBySource` method doesn't exist, `IngestionService` doesn't accept `queryApi`

**Step 3: Add getPatchesBySource to GraphQueryApi**

In `GraphQueryApi.scala` trait, add:
```scala
def getPatchesBySource(sourceUri: String, extractor: String): IO[Vector[Json]]
```

In `ArangoGraphQueryApi.scala`, implement:
```scala
def getPatchesBySource(sourceUri: String, extractor: String): IO[Vector[Json]] = {
  val aql = """
    FOR p IN patches
      FILTER p.source.uri == @uri AND p.source.extractor == @extractor
      SORT p.base_rev DESC
      RETURN p
  """
  client.query(aql, Map("uri" -> sourceUri, "extractor" -> extractor))
}
```

**Step 4: Update IngestionService to use replaces**

In `IngestionService.scala`, update constructor to accept `queryApi: GraphQueryApi`. In `ingestFile()`:

```scala
def ingestFile(filePath: Path): IO[CommitResult] = {
  for {
    content    <- IO(java.nio.file.Files.readString(filePath))
    hash        = MessageDigest.getInstance("SHA-256")
                    .digest(content.getBytes).map("%02x".format(_)).mkString
    parser     <- IO.fromOption(parserRouter.parserFor(filePath))(
                    new UnsupportedOperationException(s"No parser for $filePath"))
    result     <- parser.parse(filePath, content)
    // Check for existing patch from same source+extractor
    existing   <- queryApi.getPatchesBySource(filePath.toString, parser.name)
    prevPatch   = existing.headOption
    prevHash    = prevPatch.flatMap(_.hcursor.downField("source").get[String]("hash").toOption)
    _          <- if (prevHash.contains(hash)) IO.raiseError(new RuntimeException("Idempotent — no changes"))
                  else IO.unit
    prevPatchId = prevPatch.flatMap(_.hcursor.get[String]("patch_id").toOption).map(UUID.fromString).map(PatchId(_))
    replaces    = prevPatchId.toVector
    builder     = new GraphPatchBuilder(filePath.toString, hash)
    patch       = builder.build(result).copy(replaces = replaces)
    validated  <- IO.fromEither(PatchValidator.validate(patch).leftMap(e => new IllegalArgumentException(e)))
    commit     <- writeApi.commitPatch(validated)
  } yield commit
}
```

**Step 5: Update Main.scala to pass queryApi to IngestionService**

```scala
ingestionService = new IngestionService(parserRouter, writeApi, queryApi)
```

**Step 6: Run test**

Run: `cd memory-layer && sbt "testOnly ix.memory.EndToEndSpec"`
Expected: PASS

**Step 7: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: add replaces discovery — re-ingestion links to previous patch by source+extractor"
```

---

### Task 7: Update Confidence Scorer (6 Factors, Wall-Clock Recency)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/model/ConfidenceBreakdown.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/context/ConfidenceScorer.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ConfidenceScorerSpec.scala`

**Step 1: Write the failing test**

```scala
"ConfidenceScorerImpl" should "include intent alignment factor in score" in {
  val scorer = new ConfidenceScorerImpl()
  val claim = testClaim(sourceType = SourceType.Code)
  val ctx = ScoringContext(
    latestRev = Rev(10L),
    sourceChanged = false,
    corroboratingCount = 1,
    conflictState = ConflictState.NoConflict,
    intentAlignment = IntentAlignment.DirectlyLinked,
    observedAt = Instant.now()
  )
  val breakdown = scorer.score(claim, ctx)
  breakdown.intentAlignment.value shouldBe 1.1
  breakdown.score should be > 0.0
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.ConfidenceScorerSpec"`
Expected: FAIL — `intentAlignment` field doesn't exist, `IntentAlignment` enum doesn't exist

**Step 3: Update ConfidenceBreakdown**

Add `intentAlignment: Factor` field to `ConfidenceBreakdown`. Update the `score` method to multiply by it.

**Step 4: Add IntentAlignment enum to ScoringContext**

```scala
sealed trait IntentAlignment
object IntentAlignment {
  case object DirectlyLinked extends IntentAlignment    // × 1.1
  case object WithinTwoHops extends IntentAlignment     // × 1.05
  case object NoConnection extends IntentAlignment      // × 1.0
  case object ContradictsIntent extends IntentAlignment // × 0.85
}
```

Add `intentAlignment: IntentAlignment` and `observedAt: Instant` to `ScoringContext`.

**Step 5: Update ConfidenceScorerImpl**

Change `computeRecency` to use wall-clock time:

```scala
private def computeRecency(ctx: ScoringContext): Factor = {
  if (!ctx.sourceChanged) return Factor(1.0, "Source unchanged since observation")
  val age = java.time.Duration.between(ctx.observedAt, Instant.now())
  val days = age.toDays
  val (value, reason) = days match {
    case d if d < 1   => (1.0,  "< 1 day ago")
    case d if d <= 7  => (0.95, "1-7 days ago")
    case d if d <= 28 => (0.85, "1-4 weeks ago")
    case d if d <= 180 => (0.70, "1-6 months ago")
    case _            => (0.50, "6+ months ago")
  }
  Factor(value, reason)
}
```

Add `computeIntentAlignment`:

```scala
private def computeIntentAlignment(ctx: ScoringContext): Factor = {
  ctx.intentAlignment match {
    case IntentAlignment.DirectlyLinked    => Factor(1.1,  "Directly linked to active intent")
    case IntentAlignment.WithinTwoHops     => Factor(1.05, "Connected to intent within 2 hops")
    case IntentAlignment.NoConnection      => Factor(1.0,  "No connection to intent")
    case IntentAlignment.ContradictsIntent => Factor(0.85, "Contradicts active intent")
  }
}
```

**Step 6: Run test**

Run: `cd memory-layer && sbt "testOnly ix.memory.ConfidenceScorerSpec"`
Expected: PASS

**Step 7: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: confidence scoring — 6 factors, wall-clock recency, intent alignment"
```

---

### Task 8: Update Conflict Detector (Multi-Pass)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/context/ConflictDetector.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ConflictDetectorSpec.scala`

**Step 1: Write the failing test**

```scala
"ConflictDetectorImpl" should "detect keyword-overlap conflicts (pass 2)" in {
  val detector = new ConflictDetectorImpl()
  val claims = Vector(
    testScoredClaim("max_retries", Json.fromInt(3), 0.90),
    testScoredClaim("does not retry", Json.fromBoolean(true), 0.64)
  )
  val conflicts = detector.detect(claims)
  // "max_retries" and "does not retry" both contain "retr" → potential conflict
  conflicts should not be empty
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.ConflictDetectorSpec"`
Expected: FAIL — current detector only matches exact field names

**Step 3: Implement multi-pass conflict detection**

```scala
class ConflictDetectorImpl extends ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] = {
    val byEntity = claims.groupBy(_.claim.entityId)
    byEntity.values.flatMap { entityClaims =>
      val activeClaims = entityClaims.filter(_.claim.status == ClaimStatus.Active)
      if (activeClaims.size < 2) Vector.empty
      else {
        val pairs = activeClaims.combinations(2).toVector
        pairs.flatMap { case Vector(a, b) =>
          // Pass 1: exact field match, different value
          if (a.claim.statement == b.claim.statement && a.claim.value != b.claim.value) {
            Some(makeConflict(a, b, "Same field, different values"))
          }
          // Pass 2: keyword overlap
          else if (keywordsOverlap(a.claim.statement, b.claim.statement)) {
            Some(makeConflict(a, b, "Contradictory statements (keyword overlap)"))
          }
          else None
        }
      }
    }.toVector
  }

  private def keywordsOverlap(a: String, b: String): Boolean = {
    val wordsA = tokenize(a)
    val wordsB = tokenize(b)
    // Check for shared stems (3+ chars) that could indicate contradiction
    val stemsA = wordsA.map(_.take(4).toLowerCase).toSet
    val stemsB = wordsB.map(_.take(4).toLowerCase).toSet
    (stemsA intersect stemsB).nonEmpty
  }

  private def tokenize(s: String): Vector[String] =
    s.split("[^a-zA-Z0-9]+").filter(_.length >= 3).toVector
}
```

**Step 4: Run test**

Run: `cd memory-layer && sbt "testOnly ix.memory.ConflictDetectorSpec"`
Expected: PASS

**Step 5: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: multi-pass conflict detection — exact match + keyword overlap"
```

---

### Task 9: Update Context Pipeline (8 Steps, Relevance, Edge Priority)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/context/ContextService.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/context/GraphExpander.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/context/ContextRanker.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/RelevanceScorer.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ContextServiceSpec.scala`

**Step 1: Write the failing test**

```scala
"ContextService" should "return relevance-scored claims in StructuredContext" in {
  // Setup: create nodes, claims, query
  // Verify: claims have relevance scores, sorted by relevance × confidence
  result.claims.head.relevance should be > 0.0
  result.metadata.depth shouldBe Some("standard")
}
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.ContextServiceSpec"`
Expected: FAIL — `relevance` field doesn't exist on ScoredClaim

**Step 3: Create RelevanceScorer**

```scala
package ix.memory.context

import ix.memory.model._

object RelevanceScorer {
  def score(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge]
  ): Vector[ScoredClaim] = {
    // Build hop-distance map
    val oneHopIds = expandedEdges
      .flatMap(e => Vector(e.src, e.dst))
      .toSet -- seedNodeIds

    claims.map { sc =>
      val relevance = if (seedNodeIds.contains(sc.claim.entityId)) 1.0
                      else if (oneHopIds.contains(sc.claim.entityId)) 0.7
                      else 0.4
      sc.copy(relevance = relevance, finalScore = relevance * sc.confidence.score)
    }
  }
}
```

Add `relevance: Double = 1.0` and `finalScore: Double = 0.0` to `ScoredClaim`.

**Step 4: Update GraphExpander with edge priority**

Add priority filtering to the expand method — skip low-priority edges (MENTIONED_IN, CHANGED_WITH, SAME_AS) at hop 2+.

**Step 5: Update ContextService to use 8-step pipeline**

```scala
def query(question: String, asOfRev: Option[Rev] = None, depth: Option[String] = None): IO[StructuredContext] = {
  for {
    terms      <- IO(EntityExtractor.extract(question))          // Step 1
    seeds      <- seeder.seed(terms, asOfRev)                    // Step 2
    expanded   <- expander.expand(seeds.map(_.id), asOfRev)      // Step 3 (with priority)
    allNodeIds  = (seeds.map(_.id) ++ expanded.nodes.map(_.id)).toSet
    claims     <- collector.collect(allNodeIds)                   // Step 4
    scored     <- scoreAll(claims, asOfRev)                      // Step 5
    conflicts   = detector.detect(scored)                        // Step 6
    relevant    = RelevanceScorer.score(scored, seeds.map(_.id).toSet, expanded.edges) // Step 7
    ranked      = relevant.sortBy(-_.finalScore)                 // Step 8
    // Collect decisions and intents from expanded nodes
    decisions   = expanded.nodes.filter(_.kind == NodeKind.Decision).map(toDecisionReport)
    intents     = expanded.nodes.filter(_.kind == NodeKind.Intent).map(toIntentReport)
    metadata    = ContextMetadata(question, seeds.map(_.id.value.toString),
                    hopsExpanded = 1, asOfRev = asOfRev.getOrElse(Rev(0L)),
                    depth = depth)
  } yield StructuredContext(ranked, conflicts, decisions, intents,
            expanded.nodes, expanded.edges, metadata)
}
```

**Step 6: Run tests**

Run: `cd memory-layer && sbt "testOnly ix.memory.ContextServiceSpec"`
Expected: PASS

**Step 7: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: 8-step context pipeline — relevance scoring, edge priority, intent/decision collection"
```

---

### Task 10: Add New API Endpoints

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/DecideRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/SearchRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/TruthRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/PatchRoutes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/api/Routes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/Main.scala`
- Test: `memory-layer/src/test/scala/ix/memory/RoutesSpec.scala`

**Step 1: Write the failing tests**

```scala
"POST /v1/decide" should "create a decision node" in {
  val body = json"""{"title": "Use exponential backoff", "rationale": "Better for transient failures"}"""
  val req = Request[IO](Method.POST, uri"/v1/decide").withEntity(body)
  routes.run(req).flatMap { resp =>
    resp.status shouldBe Status.Ok
    resp.as[Json].map { body =>
      body.hcursor.get[String]("status").toOption shouldBe Some("Ok")
    }
  }
}

"POST /v1/search" should "find nodes by term" in {
  val body = json"""{"term": "billing"}"""
  val req = Request[IO](Method.POST, uri"/v1/search").withEntity(body)
  routes.run(req).flatMap { resp =>
    resp.status shouldBe Status.Ok
  }
}

"GET /v1/truth" should "return intent hierarchy" in {
  val req = Request[IO](Method.GET, uri"/v1/truth")
  routes.run(req).flatMap { resp =>
    resp.status shouldBe Status.Ok
  }
}

"GET /v1/patches" should "list recent patches" in {
  val req = Request[IO](Method.GET, uri"/v1/patches")
  routes.run(req).flatMap { resp =>
    resp.status shouldBe Status.Ok
  }
}
```

**Step 2: Run tests to verify they fail**

Run: `cd memory-layer && sbt "testOnly ix.memory.RoutesSpec"`
Expected: FAIL — routes don't exist

**Step 3: Implement route classes**

Create each route file following the pattern from existing routes (ContextRoutes, EntityRoutes). Each is a thin HTTP handler that calls the appropriate service.

`DecideRoutes.scala` — POST /v1/decide → creates Decision node via GraphWriteApi
`SearchRoutes.scala` — POST /v1/search → calls queryApi.searchNodes
`TruthRoutes.scala` — GET /v1/truth, POST /v1/truth → manage Intent nodes
`PatchRoutes.scala` — GET /v1/patches, GET /v1/patches/:id → query patches collection

**Step 4: Wire into Routes.scala**

```scala
val decideRoutes  = new DecideRoutes(writeApi).routes
val searchRoutes  = new SearchRoutes(queryApi).routes
val truthRoutes   = new TruthRoutes(writeApi, queryApi).routes
val patchRoutes   = new PatchRoutes(queryApi).routes

health <+> contextRoutes <+> ingestionRoutes <+> entityRoutes <+>
  diffRoutes <+> conflictRoutes <+> decideRoutes <+> searchRoutes <+>
  truthRoutes <+> patchRoutes
```

Update `Main.scala` to pass the new dependencies.

**Step 5: Run tests**

Run: `cd memory-layer && sbt "testOnly ix.memory.RoutesSpec"`
Expected: PASS

**Step 6: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: add /v1/decide, /v1/search, /v1/truth, /v1/patches endpoints"
```

---

### Task 11: Update All Existing Tests for No-Tenant + New Schema

**Files:**
- Modify: all test files in `memory-layer/src/test/scala/ix/memory/`

**Step 1: Run full test suite**

Run: `cd memory-layer && sbt test`
Note all failures.

**Step 2: Fix each test file**

Remove TenantId from test data, update assertions for new StructuredContext fields, ensure ArangoDB schema initialization works with new indexes.

**Step 3: Run full test suite again**

Run: `cd memory-layer && sbt test`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add memory-layer/src/test/
git commit -m "test: update all tests for no-tenant, versioned upserts, and new pipeline"
```

---

## Phase 2: TypeScript CLI + MCP Server

### Task 12: Initialize TypeScript Project

**Files:**
- Create: `ix-cli/package.json`
- Create: `ix-cli/tsconfig.json`
- Create: `ix-cli/src/index.ts`

**Step 1: Create project structure**

```bash
mkdir -p ix-cli/src/{cli,mcp/{tools,resources},client}
mkdir -p ix-cli/test
cd ix-cli
```

**Step 2: Initialize package.json**

```json
{
  "name": "@ix/cli",
  "version": "0.1.0",
  "description": "Ix Memory — Persistent Memory for LLM Systems",
  "main": "dist/index.js",
  "bin": {
    "ix": "dist/cli/main.js"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest",
    "dev": "tsx src/cli/main.ts"
  },
  "dependencies": {
    "commander": "^12.0.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "node-fetch": "^3.3.0",
    "chalk": "^5.3.0",
    "yaml": "^2.4.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "tsx": "^4.7.0",
    "@types/node": "^20.0.0"
  }
}
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true
  },
  "include": ["src"]
}
```

**Step 4: Install dependencies**

Run: `cd ix-cli && npm install`

**Step 5: Verify build**

Run: `cd ix-cli && npm run build`
Expected: Compiles with no errors

**Step 6: Commit**

```bash
git add ix-cli/
git commit -m "feat: initialize ix-cli TypeScript project with dependencies"
```

---

### Task 13: Build HTTP Client for Memory Layer API

**Files:**
- Create: `ix-cli/src/client/api.ts`
- Create: `ix-cli/src/client/types.ts`
- Test: `ix-cli/test/client.test.ts`

**Step 1: Create types.ts**

Define TypeScript interfaces matching the Scala API responses:

```typescript
export interface CommitResult {
  newRev: number;
  status: "Ok" | "Idempotent" | "BaseRevMismatch";
}

export interface ScoredClaim {
  claim: { entityId: string; statement: string; status: string };
  confidence: { score: number; breakdown: Record<string, { value: number; reason: string }> };
  relevance: number;
  finalScore: number;
}

export interface StructuredContext {
  claims: ScoredClaim[];
  conflicts: { claimA: any; claimB: any; reason: string; recommendation: string }[];
  decisions: { title: string; rationale: string; entityId?: string; intentId?: string; rev: number }[];
  intents: { id: string; statement: string; status: string; confidence: number; parentIntent?: string }[];
  nodes: any[];
  edges: any[];
  metadata: { query: string; seedEntities: string[]; hopsExpanded: number; asOfRev: number; depth?: string };
}
```

**Step 2: Create api.ts**

```typescript
export class IxClient {
  constructor(private endpoint: string = "http://localhost:8090") {}

  async query(question: string, opts?: { asOfRev?: number; depth?: string }): Promise<StructuredContext> {
    return this.post("/v1/context", { query: question, ...opts });
  }

  async ingest(path: string, recursive?: boolean): Promise<any> {
    return this.post("/v1/ingest", { path, recursive });
  }

  async decide(title: string, rationale: string, opts?: { alternatives?: string[]; entityId?: string; intentId?: string }): Promise<any> {
    return this.post("/v1/decide", { title, rationale, ...opts });
  }

  async search(term: string, kind?: string): Promise<any> {
    return this.post("/v1/search", { term, kind });
  }

  async health(): Promise<any> {
    return this.get("/v1/health");
  }

  // ... other methods for each endpoint

  private async post(path: string, body: any): Promise<any> {
    const resp = await fetch(`${this.endpoint}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  private async get(path: string): Promise<any> {
    const resp = await fetch(`${this.endpoint}${path}`);
    if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
    return resp.json();
  }
}
```

**Step 3: Write test**

```typescript
import { describe, it, expect } from "vitest";
import { IxClient } from "../src/client/api";

describe("IxClient", () => {
  it("should construct with default endpoint", () => {
    const client = new IxClient();
    expect(client).toBeDefined();
  });

  it("should construct with custom endpoint", () => {
    const client = new IxClient("http://localhost:9090");
    expect(client).toBeDefined();
  });
});
```

**Step 4: Run test**

Run: `cd ix-cli && npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add ix-cli/src/client/ ix-cli/test/
git commit -m "feat: ix-cli HTTP client with TypeScript types for Memory Layer API"
```

---

### Task 14: Build CLI Commands

**Files:**
- Create: `ix-cli/src/cli/main.ts`
- Create: `ix-cli/src/cli/commands/query.ts`
- Create: `ix-cli/src/cli/commands/ingest.ts`
- Create: `ix-cli/src/cli/commands/decide.ts`
- Create: `ix-cli/src/cli/commands/search.ts`
- Create: `ix-cli/src/cli/commands/truth.ts`
- Create: `ix-cli/src/cli/commands/patches.ts`
- Create: `ix-cli/src/cli/commands/status.ts`
- Create: `ix-cli/src/cli/commands/entity.ts`
- Create: `ix-cli/src/cli/commands/history.ts`
- Create: `ix-cli/src/cli/commands/conflicts.ts`
- Create: `ix-cli/src/cli/commands/diff.ts`
- Create: `ix-cli/src/cli/config.ts`

**Step 1: Create CLI entry point**

`main.ts`:
```typescript
#!/usr/bin/env node
import { Command } from "commander";
import { registerQueryCommand } from "./commands/query";
import { registerIngestCommand } from "./commands/ingest";
// ... etc

const program = new Command();
program.name("ix").description("Persistent Memory for LLM Systems").version("0.1.0");

registerQueryCommand(program);
registerIngestCommand(program);
// ... register all commands

program.parse();
```

**Step 2: Implement each command as thin HTTP wrapper**

Each command file follows this pattern:
```typescript
export function registerQueryCommand(program: Command) {
  program
    .command("query <question>")
    .description("Query graph → structured context")
    .option("--as-of <rev>", "Time-travel query")
    .option("--format <fmt>", "Output format", "text")
    .option("--hops <n>", "Expansion depth", "2")
    .action(async (question, opts) => {
      const client = new IxClient(getEndpoint());
      const result = await client.query(question, { asOfRev: opts.asOf ? parseInt(opts.asOf) : undefined });
      formatOutput(result, opts.format);
    });
}
```

**Step 3: Test CLI**

Run: `cd ix-cli && npx tsx src/cli/main.ts --help`
Expected: Shows help text with all commands

**Step 4: Commit**

```bash
git add ix-cli/src/cli/
git commit -m "feat: ix CLI commands — query, ingest, decide, search, truth, patches, status, etc."
```

---

### Task 15: Build MCP Server

**Files:**
- Create: `ix-cli/src/mcp/server.ts`
- Create: `ix-cli/src/mcp/tools/query.ts`
- Create: `ix-cli/src/mcp/tools/decide.ts`
- Create: `ix-cli/src/mcp/tools/ingest.ts`
- Create: `ix-cli/src/mcp/tools/search.ts`
- Create: `ix-cli/src/mcp/tools/entity.ts`
- Create: `ix-cli/src/mcp/tools/assert.ts`
- Create: `ix-cli/src/mcp/tools/diff.ts`
- Create: `ix-cli/src/mcp/tools/conflicts.ts`
- Create: `ix-cli/src/mcp/tools/resolve.ts`
- Create: `ix-cli/src/mcp/tools/expand.ts`
- Create: `ix-cli/src/mcp/tools/history.ts`
- Create: `ix-cli/src/mcp/tools/truth.ts`
- Create: `ix-cli/src/mcp/tools/patches.ts`
- Create: `ix-cli/src/mcp/resources/session.ts`
- Create: `ix-cli/src/mcp/resources/intent.ts`

**Step 1: Create MCP server**

`server.ts`:
```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { IxClient } from "../client/api";

const client = new IxClient(process.env.IX_ENDPOINT || "http://localhost:8090");

const server = new Server({
  name: "ix-memory",
  version: "0.1.0",
}, {
  capabilities: {
    tools: {},
    resources: {},
  },
});

// Register all 13 tools
// Register 2 resources (minimal nudge)

// Tool: ix_query
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ix_query",
      description: "ALWAYS call this before answering questions about the codebase...",
      inputSchema: { /* from design doc */ }
    },
    // ... all 13 tools from design doc section 8.1
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case "ix_query":
      const result = await client.query(args.question, { asOfRev: args.asOfRev, depth: args.depth });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    // ... handle all 13 tools
  }
});

// Resources: minimal nudge (~30 tokens)
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: "ix://session/context", name: "Ix Session", mimeType: "text/plain" },
    { uri: "ix://project/intent", name: "Project Intent", mimeType: "text/plain" },
  ]
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  switch (request.params.uri) {
    case "ix://session/context":
      const health = await client.health();
      return { contents: [{ uri: request.params.uri, text: `Ix Memory active. Rev ${health.rev || "?"}. ALWAYS call ix_query before answering.` }] };
    case "ix://project/intent":
      const truth = await client.listTruth();
      const root = truth.intents?.[0]?.statement || "No intent set";
      return { contents: [{ uri: request.params.uri, text: `Intent: ${root}` }] };
  }
});

// MCP Server instructions
server.setRequestHandler(/* server info */, async () => ({
  instructions: "You have access to Ix Memory — a persistent, time-aware memory system for this codebase. RULES: (1) ALWAYS call ix_query before answering questions about the codebase. (2) AFTER any design decision, call ix_decide. (3) When you notice conflicting information, call ix_conflicts. (4) NEVER answer from memory alone when Ix has data. (5) After modifying code, call ix_ingest."
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

**Step 2: Add MCP start command to CLI**

In `main.ts`:
```typescript
program
  .command("mcp")
  .command("start")
  .description("Start MCP server (stdio)")
  .action(async () => {
    await import("../mcp/server");
  });
```

**Step 3: Test MCP server starts**

Run: `echo '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' | npx tsx src/cli/main.ts mcp start`
Expected: Returns JSON-RPC response with server capabilities

**Step 4: Commit**

```bash
git add ix-cli/src/mcp/
git commit -m "feat: MCP server with 13 tools, 2 minimal resources, server instructions"
```

---

### Task 16: Build ix init and ix mcp install Commands

**Files:**
- Create: `ix-cli/src/cli/commands/init.ts`
- Create: `ix-cli/src/cli/commands/mcp-install.ts`
- Create: `templates/CLAUDE.md.template`
- Create: `templates/claude_desktop_config.json.template`

**Step 1: Create ix init**

```typescript
export function registerInitCommand(program: Command) {
  program
    .command("init")
    .description("Initialize Ix in current project")
    .action(async () => {
      console.log("Initializing Ix Memory...");

      // 1. Check backend health
      const client = new IxClient();
      try {
        await client.health();
        console.log("✓ Backend is running");
      } catch {
        console.log("✗ Backend not running. Run ./stack.sh first.");
        process.exit(1);
      }

      // 2. Create ~/.ix/config.yaml
      const configDir = path.join(os.homedir(), ".ix");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, "config.yaml"), `endpoint: http://localhost:8090\nformat: text\n`);
      console.log("✓ Created ~/.ix/config.yaml");

      // 3. Create CLAUDE.md in project root
      const claudeMd = `# Ix Memory System\n\nThis project uses Ix Memory for persistent, time-aware context.\n\n## MANDATORY RULES\n1. BEFORE answering any question about this codebase → call ix_query\n2. AFTER making any design/architecture decision → call ix_decide\n3. When noticing contradictory information → call ix_conflicts\n4. NEVER guess about codebase facts when Ix has structured data\n5. After modifying code → call ix_ingest on changed files\n6. At start of each session → review ix://session/context for prior work\n7. When the user states a goal → call ix_truth to record it\n`;
      await fs.writeFile("CLAUDE.md", claudeMd);
      console.log("✓ Created CLAUDE.md");

      console.log("\nIx Memory initialized. Run 'ix ingest ./src --recursive' to ingest your codebase.");
    });
}
```

**Step 2: Create ix mcp install**

```typescript
export function registerMcpInstallCommand(program: Command) {
  program
    .command("mcp")
    .command("install")
    .option("--cursor", "Configure Cursor instead of Claude Desktop")
    .option("--claude-code", "Configure Claude Code")
    .action(async (opts) => {
      // Write appropriate config file based on target
      if (opts.cursor) {
        // Write .cursor/mcp.json
      } else if (opts.claudeCode) {
        // Write .claude/settings.json
      } else {
        // Write claude_desktop_config.json
      }
    });
}
```

**Step 3: Test**

Run: `cd ix-cli && npx tsx src/cli/main.ts init --help`
Expected: Shows init help

**Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/init.ts ix-cli/src/cli/commands/mcp-install.ts templates/
git commit -m "feat: ix init and ix mcp install commands"
```

---

### Task 17: Docker Compose + stack.sh

**Files:**
- Create: `docker-compose.yml`
- Create: `stack.sh`
- Create: `dev.sh`
- Create: `memory-layer/Dockerfile`

**Step 1: Create docker-compose.yml**

```yaml
version: "3.8"
services:
  arangodb:
    image: arangodb:3.12
    ports: ["8529:8529"]
    environment:
      ARANGO_NO_AUTH: "1"
    volumes: [ix_arango_data:/var/lib/arangodb3]
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8529/_api/version"]
      interval: 5s
      timeout: 3s
      retries: 10

  memory-layer:
    build:
      context: ./memory-layer
      dockerfile: Dockerfile
    depends_on:
      arangodb:
        condition: service_healthy
    ports: ["8090:8090"]
    environment:
      ARANGO_HOST: arangodb
      ARANGO_PORT: "8529"
      ARANGO_DATABASE: ix_memory
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:8090/v1/health"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  ix_arango_data:
```

**Step 2: Create Dockerfile**

```dockerfile
FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY target/scala-2.13/ix-memory-assembly.jar app.jar
EXPOSE 8090
CMD ["java", "-jar", "app.jar"]
```

**Step 3: Create stack.sh**

```bash
#!/usr/bin/env bash
set -euo pipefail

case "${1:-}" in
  down)  docker compose down ;;
  logs)  docker compose logs -f ;;
  *)
    echo "Building Memory Layer..."
    (cd memory-layer && sbt assembly)
    echo "Starting Ix backend..."
    docker compose up -d --build
    echo "Waiting for health checks..."
    until curl -sf http://localhost:8090/v1/health > /dev/null 2>&1; do sleep 1; done
    echo "Ix Memory backend is ready."
    ;;
esac
```

**Step 4: Make executable and test**

```bash
chmod +x stack.sh dev.sh
```

**Step 5: Commit**

```bash
git add docker-compose.yml stack.sh dev.sh memory-layer/Dockerfile
git commit -m "feat: Docker Compose + stack.sh for backend containers"
```

---

## Phase 3: Enforcement & Polish (Higher-Level Tasks)

### Task 18: CLAUDE.md Template Optimization
- Refine CLAUDE.md enforcement rules based on testing
- Add rule 7: "When the user states a goal → call ix_truth"
- Test with Claude Code and Claude Desktop

### Task 19: Terminal UI Polish
- Add chalk-based table formatting for `ix query` output
- Add tree view for `ix truth list`
- Add color-coded confidence scores

### Task 20: Session Tracking in MCP Server
- Track working set in MCP server (last entities queried, last decisions)
- Update `ix://session/context` resource with minimal working set info

---

## Phase 4: Additional Parsers + Advanced Features (Higher-Level Tasks)

### Task 21: TypeScript Parser
- Add tree-sitter TypeScript parser to ingestion pipeline
- Generate nodes + edges + claims from .ts/.tsx files

### Task 22: Config Parser (YAML/JSON/TOML)
- Add config file parser
- Generate ConfigEntry nodes with claims

### Task 23: Markdown Parser
- Add markdown section parser
- Generate Doc nodes with claims from headers/content

### Task 24: Corroboration Counting
- In confidence scorer, query for matching claims from independent sources
- Boost corroboration multiplier

### Task 25: Staleness Detection
- Compare current file hash to source_hash in latest patch
- Mark claims as stale when hash changes

### Task 26: LLM-Assisted Conflict Detection (Pass 3)
- Add optional LLM call in conflict detector
- Record LLM judgment as patch (source: LLM, 0.40)

---

## Execution Summary

| Phase | Tasks | Estimated Scope |
|-------|-------|----------------|
| Phase 1 | Tasks 1-11 | Modify ~30 Scala files, update all tests |
| Phase 2 | Tasks 12-17 | Create ~25 TypeScript files, Docker setup |
| Phase 3 | Tasks 18-20 | Polish and optimization |
| Phase 4 | Tasks 21-26 | Additional parsers and advanced features |

**Start with Phase 1, Task 1.** Each task builds on the previous one. Run tests after every task.
