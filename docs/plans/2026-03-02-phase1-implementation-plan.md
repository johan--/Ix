# Phase 1: Memory Layer Core — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Memory Layer core engine — a Scala HTTP service that ingests source code into a temporal property graph, queries it for structured claims with computed confidence and conflict detection, and serves results via REST API.

**Architecture:** Single Scala sbt project (multi-module: memory-layer, cli, mcp-server). Phase 1 focuses on memory-layer only. The service exposes HTTP endpoints backed by ArangoDB. Ingestion uses tree-sitter for Python AST parsing. The context pipeline extracts entities from queries, seeds the graph, expands neighborhoods, collects claims, scores confidence, detects conflicts, and returns StructuredContext.

**Tech Stack:**
- Scala 2.13, Cats Effect 3.5.4, http4s 0.23.x, Circe 0.14.x
- ArangoDB Java Driver 7.12.0
- java-tree-sitter 1.12.0 (ch.usi.si.seart) for Python AST parsing
- ScalaTest 3.2.x for testing
- Docker for ArangoDB

**Reference:** Design doc at `docs/plans/2026-03-02-ix-memory-design.md`

---

## Task 1: Project Scaffold

**Files:**
- Create: `build.sbt`
- Create: `project/build.properties`
- Create: `project/plugins.sbt`
- Create: `.gitignore`
- Create: `docker-compose.yml`
- Create: `memory-layer/src/main/resources/logback.xml`

**Step 1: Create build.sbt with multi-module layout**

```scala
ThisBuild / scalaVersion := "2.13.16"
ThisBuild / organization := "ix"
ThisBuild / version      := "0.1.0-SNAPSHOT"

val CatsEffectVersion = "3.5.4"
val Http4sVersion     = "0.23.30"
val CirceVersion      = "0.14.10"
val ArangoVersion     = "7.12.0"
val TreeSitterVersion = "1.12.0"
val LogbackVersion    = "1.5.6"
val Log4CatsVersion   = "2.7.0"
val ScalaTestVersion  = "3.2.18"
val CatsEffectTestVersion = "1.5.0"

lazy val commonDeps = Seq(
  "org.typelevel"       %% "cats-effect"         % CatsEffectVersion,
  "io.circe"            %% "circe-core"          % CirceVersion,
  "io.circe"            %% "circe-generic"       % CirceVersion,
  "io.circe"            %% "circe-parser"        % CirceVersion,
  "org.typelevel"       %% "log4cats-slf4j"      % Log4CatsVersion,
  "ch.qos.logback"       % "logback-classic"     % LogbackVersion,
  "org.scalatest"       %% "scalatest"           % ScalaTestVersion  % Test,
  "org.typelevel"       %% "cats-effect-testing-scalatest" % CatsEffectTestVersion % Test
)

lazy val `memory-layer` = (project in file("memory-layer"))
  .settings(
    name := "ix-memory-layer",
    libraryDependencies ++= commonDeps ++ Seq(
      "org.http4s"          %% "http4s-ember-server" % Http4sVersion,
      "org.http4s"          %% "http4s-dsl"          % Http4sVersion,
      "org.http4s"          %% "http4s-circe"        % Http4sVersion,
      "com.arangodb"          % "arangodb-java-driver" % ArangoVersion,
      "ch.usi.si.seart"       % "java-tree-sitter"   % TreeSitterVersion
    ),
    assembly / mainClass := Some("ix.memory.Main"),
    assembly / assemblyJarName := "ix-memory-layer.jar",
    assembly / assemblyMergeStrategy := {
      case PathList("META-INF", _*) => MergeStrategy.discard
      case _ => MergeStrategy.first
    }
  )

lazy val root = (project in file("."))
  .aggregate(`memory-layer`)
  .settings(name := "ix-memory")
```

**Step 2: Create project/build.properties**

```
sbt.version=1.10.7
```

**Step 3: Create project/plugins.sbt**

```scala
addSbtPlugin("com.eed3si9n" % "sbt-assembly" % "2.3.0")
```

**Step 4: Create .gitignore**

```
target/
.bsp/
.idea/
*.class
*.jar
.DS_Store
```

**Step 5: Create docker-compose.yml**

```yaml
version: "3.8"
services:
  arangodb:
    image: arangodb:3.12
    ports:
      - "8529:8529"
    environment:
      ARANGO_ROOT_PASSWORD: ""
      ARANGO_NO_AUTH: "1"
    volumes:
      - arango-data:/var/lib/arangodb3
volumes:
  arango-data:
```

**Step 6: Create memory-layer/src/main/resources/logback.xml**

```xml
<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender">
    <encoder>
      <pattern>%d{HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n</pattern>
    </encoder>
  </appender>
  <root level="INFO">
    <appender-ref ref="STDOUT" />
  </root>
</configuration>
```

**Step 7: Verify build compiles**

Run: `cd /Users/rileythompson/startprojes/startup/IX-Memory-Repo && sbt compile`
Expected: BUILD SUCCESS (no source files yet, just verifying deps resolve)

**Step 8: Start ArangoDB**

Run: `cd /Users/rileythompson/startprojes/startup/IX-Memory-Repo && docker compose up -d`
Expected: ArangoDB running on port 8529

**Step 9: Commit**

```bash
git add build.sbt project/ .gitignore docker-compose.yml memory-layer/
git commit -m "feat: scaffold project with sbt multi-module build and docker-compose"
```

---

## Task 2: Core Data Model

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/model/Identifiers.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/Provenance.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/Node.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/Edge.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/Claim.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/GraphPatch.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/ConflictSet.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/ConfidenceBreakdown.scala`
- Create: `memory-layer/src/main/scala/ix/memory/model/StructuredContext.scala`
- Test: `memory-layer/src/test/scala/ix/memory/model/ModelSpec.scala`

**Step 1: Write the failing test for model serialization**

```scala
// memory-layer/src/test/scala/ix/memory/model/ModelSpec.scala
package ix.memory.model

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.syntax._
import io.circe.parser._
import java.time.Instant
import java.util.UUID

class ModelSpec extends AnyFlatSpec with Matchers {

  "Provenance" should "round-trip through JSON" in {
    val p = Provenance(
      sourceUri   = "billing.py",
      sourceHash  = Some("a1b2c3"),
      extractor   = "tree-sitter-python/1.0",
      sourceType  = SourceType.Code,
      observedAt  = Instant.parse("2026-03-01T10:00:00Z")
    )
    val json = p.asJson
    val decoded = json.as[Provenance]
    decoded shouldBe Right(p)
  }

  "GraphPatch" should "serialize with all ops" in {
    val patch = GraphPatch(
      patchId   = PatchId(UUID.randomUUID()),
      tenant    = TenantId("test"),
      actor     = "ci/tree-sitter",
      timestamp = Instant.now(),
      source    = PatchSource(
        uri        = "billing.py",
        hash       = Some("a1b2c3"),
        extractor  = "tree-sitter-python/1.0",
        sourceType = SourceType.Code
      ),
      baseRev   = None,
      ops       = Vector(
        PatchOp.UpsertNode(
          NodeId(UUID.randomUUID()),
          NodeKind.Function,
          Map("name" -> "retry_handler".asJson, "line_start" -> 45.asJson)
        )
      ),
      replaces  = Vector.empty,
      intent    = Some("Parsed billing.py")
    )
    val json = patch.asJson
    json.hcursor.get[String]("patch_id").isRight shouldBe true
    json.hcursor.get[String]("actor") shouldBe Right("ci/tree-sitter")
  }

  "SourceType" should "encode and decode correctly" in {
    SourceType.Code.asJson.noSpaces shouldBe "\"code\""
    parse("\"config\"").flatMap(_.as[SourceType]) shouldBe Right(SourceType.Config)
  }

  "NodeKind" should "encode and decode correctly" in {
    NodeKind.Function.asJson.noSpaces shouldBe "\"function\""
    NodeKind.Module.asJson.noSpaces shouldBe "\"module\""
  }

  "ConfidenceBreakdown" should "compute score from factors" in {
    val breakdown = ConfidenceBreakdown(
      baseAuthority   = Factor(0.90, "code, AST-parsed"),
      verification    = Factor(1.1, "covered by passing test"),
      recency         = Factor(1.0, "source unchanged"),
      corroboration   = Factor(1.1, "2 independent sources agree"),
      conflictPenalty = Factor(0.85, "conflict with lower-authority source")
    )
    // 0.90 * 1.1 * 1.0 * 1.1 * 0.85 = 0.92565
    breakdown.score shouldBe 0.926 +- 0.001
  }
}
```

**Step 2: Run test to verify it fails**

Run: `cd /Users/rileythompson/startprojes/startup/IX-Memory-Repo && sbt "memory-layer/testOnly ix.memory.model.ModelSpec"`
Expected: FAIL — classes don't exist yet

**Step 3: Implement Identifiers.scala**

```scala
// memory-layer/src/main/scala/ix/memory/model/Identifiers.scala
package ix.memory.model

import java.util.UUID
import io.circe.{Encoder, Decoder}

case class TenantId(value: String) extends AnyVal
object TenantId {
  implicit val encoder: Encoder[TenantId] = Encoder.encodeString.contramap(_.value)
  implicit val decoder: Decoder[TenantId] = Decoder.decodeString.map(TenantId(_))
}

case class NodeId(value: UUID) extends AnyVal
object NodeId {
  def random: NodeId = NodeId(UUID.randomUUID())
  implicit val encoder: Encoder[NodeId] = Encoder.encodeUUID.contramap(_.value)
  implicit val decoder: Decoder[NodeId] = Decoder.decodeUUID.map(NodeId(_))
}

case class EdgeId(value: UUID) extends AnyVal
object EdgeId {
  def random: EdgeId = EdgeId(UUID.randomUUID())
  def derived(src: NodeId, dst: NodeId, predicate: String): EdgeId = {
    val name = s"${src.value}:${dst.value}:$predicate"
    EdgeId(UUID.nameUUIDFromBytes(name.getBytes("UTF-8")))
  }
  implicit val encoder: Encoder[EdgeId] = Encoder.encodeUUID.contramap(_.value)
  implicit val decoder: Decoder[EdgeId] = Decoder.decodeUUID.map(EdgeId(_))
}

case class PatchId(value: UUID) extends AnyVal
object PatchId {
  def random: PatchId = PatchId(UUID.randomUUID())
  implicit val encoder: Encoder[PatchId] = Encoder.encodeUUID.contramap(_.value)
  implicit val decoder: Decoder[PatchId] = Decoder.decodeUUID.map(PatchId(_))
}

case class ClaimId(value: UUID) extends AnyVal
object ClaimId {
  def random: ClaimId = ClaimId(UUID.randomUUID())
  implicit val encoder: Encoder[ClaimId] = Encoder.encodeUUID.contramap(_.value)
  implicit val decoder: Decoder[ClaimId] = Decoder.decodeUUID.map(ClaimId(_))
}

case class ConflictId(value: UUID) extends AnyVal
object ConflictId {
  def random: ConflictId = ConflictId(UUID.randomUUID())
  implicit val encoder: Encoder[ConflictId] = Encoder.encodeUUID.contramap(_.value)
  implicit val decoder: Decoder[ConflictId] = Decoder.decodeUUID.map(ConflictId(_))
}

// Monotonic revision counter per tenant
case class Rev(value: Long) extends AnyVal
object Rev {
  implicit val encoder: Encoder[Rev] = Encoder.encodeLong.contramap(_.value)
  implicit val decoder: Decoder[Rev] = Decoder.decodeLong.map(Rev(_))
}
```

**Step 4: Implement Provenance.scala**

```scala
// memory-layer/src/main/scala/ix/memory/model/Provenance.scala
package ix.memory.model

import java.time.Instant
import io.circe.{Encoder, Decoder}
import io.circe.generic.semiauto._

sealed trait SourceType
object SourceType {
  case object Code       extends SourceType
  case object Config     extends SourceType
  case object Doc        extends SourceType
  case object Test       extends SourceType
  case object Schema     extends SourceType
  case object Commit     extends SourceType
  case object Comment    extends SourceType
  case object Inferred   extends SourceType
  case object Human      extends SourceType

  implicit val encoder: Encoder[SourceType] = Encoder.encodeString.contramap {
    case Code     => "code"
    case Config   => "config"
    case Doc      => "doc"
    case Test     => "test"
    case Schema   => "schema"
    case Commit   => "commit"
    case Comment  => "comment"
    case Inferred => "inferred"
    case Human    => "human"
  }

  implicit val decoder: Decoder[SourceType] = Decoder.decodeString.emap {
    case "code"     => Right(Code)
    case "config"   => Right(Config)
    case "doc"      => Right(Doc)
    case "test"     => Right(Test)
    case "schema"   => Right(Schema)
    case "commit"   => Right(Commit)
    case "comment"  => Right(Comment)
    case "inferred" => Right(Inferred)
    case "human"    => Right(Human)
    case other      => Left(s"Unknown source type: $other")
  }

  def baseAuthority(st: SourceType): Double = st match {
    case Test     => 0.95
    case Code     => 0.90
    case Config   => 0.85
    case Schema   => 0.85
    case Doc      => 0.75
    case Commit   => 0.60
    case Comment  => 0.50
    case Inferred => 0.40
    case Human    => 0.80
  }
}

case class Provenance(
  sourceUri:   String,
  sourceHash:  Option[String],
  extractor:   String,
  sourceType:  SourceType,
  observedAt:  Instant
)
object Provenance {
  implicit val encoder: Encoder[Provenance] = deriveEncoder
  implicit val decoder: Decoder[Provenance] = deriveDecoder
}
```

**Step 5: Implement remaining model files**

Implement `Node.scala`, `Edge.scala`, `Claim.scala`, `GraphPatch.scala`, `ConflictSet.scala`, `ConfidenceBreakdown.scala`, `StructuredContext.scala` following the design doc schema. Each file follows the same pattern: case class + Circe encoder/decoder.

Key types:

```scala
// Node.scala
sealed trait NodeKind
object NodeKind {
  case object Module      extends NodeKind
  case object File        extends NodeKind
  case object Class       extends NodeKind
  case object Function    extends NodeKind
  case object Variable    extends NodeKind
  case object Config      extends NodeKind
  case object ConfigEntry extends NodeKind
  case object Service     extends NodeKind
  case object Endpoint    extends NodeKind
  // encoder/decoder mapping to lowercase strings
}

case class GraphNode(
  id:         NodeId,
  kind:       NodeKind,
  tenant:     TenantId,
  attrs:      io.circe.Json,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev],
  createdAt:  Instant,
  updatedAt:  Instant
)

// Edge.scala
case class EdgePredicate(value: String) extends AnyVal

case class GraphEdge(
  id:         EdgeId,
  src:        NodeId,
  dst:        NodeId,
  predicate:  EdgePredicate,
  tenant:     TenantId,
  attrs:      io.circe.Json,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev]
)

// Claim.scala
sealed trait ClaimStatus
object ClaimStatus {
  case object Active    extends ClaimStatus
  case object Stale     extends ClaimStatus
  case object Retracted extends ClaimStatus
}

case class Claim(
  id:         ClaimId,
  entityId:   NodeId,
  statement:  String,
  status:     ClaimStatus,
  provenance: Provenance,
  createdRev: Rev,
  deletedRev: Option[Rev]
)

// GraphPatch.scala — PatchOp and GraphPatch
sealed trait PatchOp
object PatchOp {
  case class UpsertNode(id: NodeId, kind: NodeKind, attrs: Map[String, io.circe.Json]) extends PatchOp
  case class UpsertEdge(src: NodeId, dst: NodeId, predicate: String, attrs: Map[String, io.circe.Json]) extends PatchOp
  case class DeleteNode(id: NodeId) extends PatchOp
  case class DeleteEdge(id: EdgeId) extends PatchOp
  case class AssertClaim(entityId: NodeId, statement: String) extends PatchOp
  case class RetractClaim(claimId: ClaimId, reason: String) extends PatchOp
}

case class PatchSource(
  uri:        String,
  hash:       Option[String],
  extractor:  String,
  sourceType: SourceType
)

case class GraphPatch(
  patchId:   PatchId,
  tenant:    TenantId,
  actor:     String,
  timestamp: Instant,
  source:    PatchSource,
  baseRev:   Option[Rev],
  ops:       Vector[PatchOp],
  replaces:  Vector[PatchId],
  intent:    Option[String]
)

// ConflictSet.scala
sealed trait ConflictStatus
object ConflictStatus {
  case object Open      extends ConflictStatus
  case object Resolved  extends ConflictStatus
  case object Dismissed extends ConflictStatus
}

case class ConflictSet(
  id:              ConflictId,
  reason:          String,
  status:          ConflictStatus,
  candidateClaims: Vector[ClaimId],
  winnerClaimId:   Option[ClaimId],
  createdRev:      Rev
)

// ConfidenceBreakdown.scala
case class Factor(value: Double, reason: String)

case class ConfidenceBreakdown(
  baseAuthority:   Factor,
  verification:    Factor,
  recency:         Factor,
  corroboration:   Factor,
  conflictPenalty: Factor
) {
  def score: Double = {
    val raw = baseAuthority.value *
              verification.value *
              recency.value *
              corroboration.value *
              conflictPenalty.value
    math.max(0.0, math.min(1.0, raw))
  }
}

// StructuredContext.scala
case class ScoredClaim(
  claim:      Claim,
  confidence: ConfidenceBreakdown
)

case class ConflictReport(
  id:             ConflictId,
  claimA:         ScoredClaim,
  claimB:         ScoredClaim,
  reason:         String,
  recommendation: String
)

case class StructuredContext(
  claims:    Vector[ScoredClaim],
  conflicts: Vector[ConflictReport],
  nodes:     Vector[GraphNode],
  edges:     Vector[GraphEdge],
  metadata:  ContextMetadata
)

case class ContextMetadata(
  query:          String,
  seedEntities:   Vector[String],
  hopsExpanded:   Int,
  asOfRev:        Rev
)
```

**Step 6: Run tests to verify they pass**

Run: `cd /Users/rileythompson/startprojes/startup/IX-Memory-Repo && sbt "memory-layer/testOnly ix.memory.model.ModelSpec"`
Expected: PASS — all model serialization tests green

**Step 7: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: add core data model — GraphPatch, Node, Edge, Claim, Provenance, Confidence"
```

---

## Task 3: ArangoDB Client + Schema

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala`
- Create: `memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala`
- Test: `memory-layer/src/test/scala/ix/memory/db/ArangoClientSpec.scala`

**Prereq:** ArangoDB running via docker-compose (Task 1, Step 8)

**Step 1: Write the failing integration test**

```scala
// memory-layer/src/test/scala/ix/memory/db/ArangoClientSpec.scala
package ix.memory.db

import cats.effect.IO
import cats.effect.testing.scalatest.AsyncIOSpec
import org.scalatest.flatspec.AsyncFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.Json

class ArangoClientSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  // Requires ArangoDB running on localhost:8529
  val clientResource = ArangoClient.resource(
    host = "localhost", port = 8529,
    database = "ix_memory_test", user = "root", password = ""
  )

  "ArangoClient" should "connect and ensure schema" in {
    clientResource.use { client =>
      client.ensureSchema().map(_ => succeed)
    }
  }

  it should "execute a simple query" in {
    clientResource.use { client =>
      for {
        _       <- client.ensureSchema()
        results <- client.query("RETURN 1", Map.empty)
      } yield results.size shouldBe 1
    }
  }

  it should "insert and retrieve a document" in {
    clientResource.use { client =>
      for {
        _ <- client.ensureSchema()
        _ <- client.execute(
          "INSERT { _key: @key, name: @name } INTO nodes",
          Map("key" -> "test1", "name" -> "testNode")
        )
        result <- client.queryOne(
          "FOR n IN nodes FILTER n._key == @key RETURN n",
          Map("key" -> "test1")
        )
      } yield {
        result shouldBe defined
        result.get.hcursor.get[String]("name") shouldBe Right("testNode")
      }
    }
  }
}
```

**Step 2: Run test to verify it fails**

Run: `sbt "memory-layer/testOnly ix.memory.db.ArangoClientSpec"`
Expected: FAIL — ArangoClient doesn't exist

**Step 3: Implement ArangoClient.scala**

Adapt from SD_Query_Engine's `ArangoClient.scala`. Key changes:
- Use `ix_memory` database name by default
- Resource-based lifecycle with Cats Effect
- `query`, `queryOne`, `execute` methods wrapping ArangoDB Java driver
- `ensureSchema()` delegates to `ArangoSchema`

```scala
// memory-layer/src/main/scala/ix/memory/db/ArangoClient.scala
package ix.memory.db

import cats.effect.{IO, Resource}
import com.arangodb.{ArangoDB, ArangoDatabase}
import com.arangodb.entity.CollectionType
import com.arangodb.model.CollectionCreateOptions
import io.circe.{Json, parser => circeParser}
import scala.jdk.CollectionConverters._

class ArangoClient private (db: ArangoDatabase) {

  def query(aql: String, bindVars: Map[String, AnyRef]): IO[List[Json]] = IO.blocking {
    val cursor = db.query(aql, classOf[String], bindVars.asJava)
    cursor.asListRemaining().asScala.toList.flatMap(s =>
      circeParser.parse(s).toOption
    )
  }

  def queryOne(aql: String, bindVars: Map[String, AnyRef]): IO[Option[Json]] =
    query(aql, bindVars).map(_.headOption)

  def execute(aql: String, bindVars: Map[String, AnyRef]): IO[Unit] = IO.blocking {
    db.query(aql, classOf[Void], bindVars.asJava)
    ()
  }

  def ensureSchema(): IO[Unit] = ArangoSchema.ensure(this, db)
}

object ArangoClient {
  def resource(
    host: String, port: Int,
    database: String, user: String, password: String
  ): Resource[IO, ArangoClient] = {
    Resource.make(IO.blocking {
      val arango = new ArangoDB.Builder()
        .host(host, port)
        .user(user)
        .password(password)
        .build()
      // Ensure database exists
      if (!arango.getDatabases.contains(database)) {
        arango.createDatabase(database)
      }
      val db = arango.db(database)
      (arango, new ArangoClient(db))
    })(pair => IO.blocking(pair._1.shutdown())).map(_._2)
  }
}
```

**Step 4: Implement ArangoSchema.scala**

```scala
// memory-layer/src/main/scala/ix/memory/db/ArangoSchema.scala
package ix.memory.db

import cats.effect.IO
import com.arangodb.ArangoDatabase
import com.arangodb.entity.CollectionType
import com.arangodb.model.{CollectionCreateOptions, HashIndexOptions, TtlIndexOptions}
import scala.jdk.CollectionConverters._

object ArangoSchema {
  def ensure(client: ArangoClient, db: ArangoDatabase): IO[Unit] = IO.blocking {
    // Vertex collections
    ensureCollection(db, "nodes")
    ensureCollection(db, "claims")
    ensureCollection(db, "conflict_sets")
    ensureCollection(db, "patches")        // The event log
    ensureCollection(db, "revisions")      // Per-tenant revision counter
    ensureCollection(db, "idempotency_keys")

    // Edge collection
    ensureCollection(db, "edges", edge = true)

    // Indexes
    val nodes = db.collection("nodes")
    nodes.ensureHashIndex(List("tenant", "kind").asJava, new HashIndexOptions())
    nodes.ensureHashIndex(List("tenant", "attrs.name").asJava,
      new HashIndexOptions().sparse(true))

    val edges = db.collection("edges")
    edges.ensureHashIndex(List("tenant", "src").asJava, new HashIndexOptions())
    edges.ensureHashIndex(List("tenant", "dst").asJava, new HashIndexOptions())
    edges.ensureHashIndex(List("tenant", "predicate").asJava, new HashIndexOptions())

    val claims = db.collection("claims")
    claims.ensureHashIndex(List("tenant", "entity_id").asJava, new HashIndexOptions())
    claims.ensureHashIndex(List("tenant", "status").asJava, new HashIndexOptions())

    val patches = db.collection("patches")
    patches.ensureHashIndex(List("tenant", "patch_id").asJava,
      new HashIndexOptions().unique(true))

    val idem = db.collection("idempotency_keys")
    idem.ensureHashIndex(List("key").asJava, new HashIndexOptions().unique(true))
    idem.ensureTtlIndex(List("created_at").asJava, new TtlIndexOptions().expireAfter(86400))
  }

  private def ensureCollection(db: ArangoDatabase, name: String, edge: Boolean = false): Unit = {
    if (!db.collection(name).exists()) {
      val opts = new CollectionCreateOptions()
      if (edge) opts.`type`(CollectionType.EDGES)
      db.createCollection(name, opts)
    }
  }
}
```

**Step 5: Run tests to verify they pass**

Run: `sbt "memory-layer/testOnly ix.memory.db.ArangoClientSpec"`
Expected: PASS (requires ArangoDB running)

**Step 6: Commit**

```bash
git add memory-layer/src/
git commit -m "feat: add ArangoDB client with schema initialization"
```

---

## Task 4: Graph Write API — Patch Commit

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/GraphWriteApi.scala`
- Create: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphWriteApi.scala`
- Test: `memory-layer/src/test/scala/ix/memory/db/GraphWriteApiSpec.scala`

**Step 1: Write the failing test**

```scala
package ix.memory.db

class GraphWriteApiSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  "GraphWriteApi" should "commit a patch and increment revision" in {
    clientResource.use { client =>
      val api = ArangoGraphWriteApi(client)
      val patch = GraphPatch(
        patchId = PatchId.random,
        tenant  = TenantId("test"),
        actor   = "test",
        timestamp = Instant.now(),
        source  = PatchSource("test.py", None, "test", SourceType.Code),
        baseRev = None,
        ops     = Vector(PatchOp.UpsertNode(NodeId.random, NodeKind.Function,
                    Map("name" -> "foo".asJson))),
        replaces = Vector.empty,
        intent  = Some("test")
      )
      for {
        _      <- client.ensureSchema()
        result <- api.commitPatch(patch)
      } yield {
        result.newRev.value should be > 0L
        result.status shouldBe CommitStatus.Ok
      }
    }
  }

  it should "be idempotent on duplicate patch_id" in {
    clientResource.use { client =>
      val api = ArangoGraphWriteApi(client)
      val patchId = PatchId.random
      val patch = // ... same patch with same patchId
      for {
        _  <- client.ensureSchema()
        r1 <- api.commitPatch(patch)
        r2 <- api.commitPatch(patch)
      } yield {
        r1.status shouldBe CommitStatus.Ok
        r2.status shouldBe CommitStatus.Idempotent
        r1.newRev shouldBe r2.newRev
      }
    }
  }
}
```

**Step 2: Run test, verify fails**

**Step 3: Implement GraphWriteApi trait + ArangoGraphWriteApi**

The `commitPatch` method:
1. Check idempotency (patch_id already applied → return stored rev)
2. Load latest_rev for tenant
3. If base_rev provided and != latest_rev → return CONFLICT
4. new_rev = latest_rev + 1
5. For each op in patch: execute the corresponding AQL
6. Store patch in `patches` collection
7. Store idempotency key
8. Update tenant revision
9. Return CommitResult(new_rev, status)

```scala
trait GraphWriteApi {
  def commitPatch(patch: GraphPatch): IO[CommitResult]
}

case class CommitResult(newRev: Rev, status: CommitStatus)

sealed trait CommitStatus
object CommitStatus {
  case object Ok              extends CommitStatus
  case object Idempotent      extends CommitStatus
  case object BaseRevMismatch extends CommitStatus
  case object Error            extends CommitStatus
}
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat: add GraphWriteApi with patch commit, MVCC, and idempotency"
```

---

## Task 5: Graph Query API

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`
- Create: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`
- Test: `memory-layer/src/test/scala/ix/memory/db/GraphQueryApiSpec.scala`

**Step 1: Write the failing test**

Test should:
- Commit a patch with 2 nodes and 1 edge
- Query getNode by id → returns the node with correct attrs
- Query expand from node → returns connected nodes + edges
- Query with asOfRev → returns only entities visible at that revision
- Query findNodesByKind → returns nodes of a given kind
- Fulltext search by node name → returns matching nodes

**Step 2: Implement GraphQueryApi trait**

```scala
trait GraphQueryApi {
  def getNode(tenant: TenantId, id: NodeId, asOfRev: Option[Rev] = None): IO[Option[GraphNode]]
  def findNodesByKind(tenant: TenantId, kind: NodeKind, limit: Int = 100): IO[Vector[GraphNode]]
  def searchNodes(tenant: TenantId, text: String, limit: Int = 20): IO[Vector[GraphNode]]
  def expand(tenant: TenantId, nodeId: NodeId, direction: Direction,
             predicates: Option[Set[String]] = None, hops: Int = 1,
             asOfRev: Option[Rev] = None): IO[ExpandResult]
  def getClaims(tenant: TenantId, entityId: NodeId): IO[Vector[Claim]]
  def getLatestRev(tenant: TenantId): IO[Rev]
}

sealed trait Direction
object Direction {
  case object Out  extends Direction
  case object In   extends Direction
  case object Both extends Direction
}

case class ExpandResult(nodes: Vector[GraphNode], edges: Vector[GraphEdge])
```

**Step 3: Implement ArangoGraphQueryApi** with AQL queries:
- `getNode`: `FOR n IN nodes FILTER n._key == @id AND n.tenant == @tenant AND n.created_rev <= @rev AND (n.deleted_rev == null OR @rev < n.deleted_rev) RETURN n`
- `expand`: adjacency query using edges collection, filtering by direction and predicate
- `searchNodes`: `FOR n IN nodes FILTER n.tenant == @tenant AND CONTAINS(LOWER(n.attrs.name), LOWER(@text)) RETURN n`

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat: add GraphQueryApi with getNode, expand, search, and MVCC visibility"
```

---

## Task 6: Ingestion — Tree-Sitter Python Parser

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/ingestion/IngestionService.scala`
- Create: `memory-layer/src/main/scala/ix/memory/ingestion/ParserRouter.scala`
- Create: `memory-layer/src/main/scala/ix/memory/ingestion/parsers/TreeSitterPythonParser.scala`
- Create: `memory-layer/src/main/scala/ix/memory/ingestion/GraphPatchBuilder.scala`
- Create: `memory-layer/src/main/scala/ix/memory/ingestion/PatchValidator.scala`
- Test: `memory-layer/src/test/scala/ix/memory/ingestion/TreeSitterPythonParserSpec.scala`
- Test fixture: `memory-layer/src/test/resources/fixtures/billing_service.py`

**Step 1: Create test fixture**

```python
# memory-layer/src/test/resources/fixtures/billing_service.py
import http_client
from config import RETRY_COUNT

class BillingService:
    def __init__(self, gateway):
        self.gateway = gateway

    def process_payment(self, amount, currency):
        result = self.gateway.charge(amount, currency)
        if not result.success:
            self.retry_handler(amount, currency)
        return result

    def retry_handler(self, amount, currency, max_retries=3):
        for attempt in range(max_retries):
            result = self.gateway.charge(amount, currency)
            if result.success:
                return result
        raise PaymentError("Max retries exceeded")

def standalone_function():
    return BillingService(None)
```

**Step 2: Write the failing test**

```scala
class TreeSitterPythonParserSpec extends AnyFlatSpec with Matchers {

  val parser = new TreeSitterPythonParser()

  "TreeSitterPythonParser" should "extract functions from Python source" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)

    val nodeNames = result.nodes.flatMap(_.attrs.hcursor.get[String]("name").toOption)
    nodeNames should contain("BillingService")
    nodeNames should contain("process_payment")
    nodeNames should contain("retry_handler")
    nodeNames should contain("standalone_function")
  }

  it should "extract import relationships" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)

    val importEdges = result.edges.filter(_.predicate == "IMPORTS")
    importEdges.size should be >= 2
  }

  it should "extract class-to-method DEFINES edges" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)

    val definesEdges = result.edges.filter(_.predicate == "DEFINES")
    definesEdges.size should be >= 3  // BillingService defines __init__, process_payment, retry_handler
  }

  it should "extract function call relationships" in {
    val source = scala.io.Source.fromResource("fixtures/billing_service.py").mkString
    val result = parser.parse("billing_service.py", source)

    val callEdges = result.edges.filter(_.predicate == "CALLS")
    callEdges.size should be >= 1  // process_payment calls retry_handler
  }
}
```

**Step 3: Implement TreeSitterPythonParser**

Uses `ch.usi.si.seart:java-tree-sitter`:
- Parse source with `Language.PYTHON`
- Query for `function_definition`, `class_definition`, `import_statement`, `import_from_statement`, `call`
- Build intermediate `ParseResult(nodes, edges)` with extracted entities

```scala
case class ParsedEntity(
  name: String,
  kind: NodeKind,
  attrs: Map[String, Json],
  lineStart: Int,
  lineEnd: Int
)

case class ParsedRelationship(
  srcName: String,
  dstName: String,
  predicate: String
)

case class ParseResult(
  entities: Vector[ParsedEntity],
  relationships: Vector[ParsedRelationship]
)
```

Tree-sitter queries:
- Functions: `(function_definition name: (identifier) @name)`
- Classes: `(class_definition name: (identifier) @name)`
- Imports: `[(import_statement) @imp (import_from_statement) @imp]`
- Calls: `(call function: (identifier) @fn)`

**Step 4: Implement GraphPatchBuilder**

Takes `ParseResult` + file metadata → produces `GraphPatch` with proper provenance:
- Each ParsedEntity → `PatchOp.UpsertNode`
- Each ParsedRelationship → `PatchOp.UpsertEdge`
- Deterministic NodeId from `(tenant, file_path, entity_name)` using UUID.nameUUIDFromBytes
- Provenance set from file path, content hash, extractor name

**Step 5: Implement ParserRouter**

Routes by file extension:
- `.py` → `TreeSitterPythonParser`
- Others → error (future parsers)

**Step 6: Implement IngestionService**

Orchestrates: discover files → parse → build patches → validate → commit

```scala
class IngestionService(parserRouter: ParserRouter, writeApi: GraphWriteApi) {
  def ingestPath(tenant: TenantId, path: Path, language: Option[String],
                 recursive: Boolean): IO[IngestionResult]
  def ingestFile(tenant: TenantId, filePath: Path): IO[CommitResult]
}

case class IngestionResult(
  filesProcessed: Int,
  patchesApplied: Int,
  entitiesCreated: Int,
  latestRev: Rev
)
```

**Step 7: Run tests, verify pass**

**Step 8: Commit**

```bash
git commit -m "feat: add ingestion pipeline with tree-sitter Python parser"
```

---

## Task 7: Context Service — Query Pipeline

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/context/ContextService.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/EntityExtractor.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/GraphSeeder.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/GraphExpander.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/ClaimCollector.scala`
- Create: `memory-layer/src/main/scala/ix/memory/context/ContextRanker.scala`
- Test: `memory-layer/src/test/scala/ix/memory/context/ContextServiceSpec.scala`

**Step 1: Write the failing integration test**

Test should:
1. Ingest the billing_service.py fixture
2. Call `contextService.query("How does billing retry?")`
3. Verify the returned StructuredContext contains:
   - Nodes related to billing/retry
   - Claims (if any were asserted during ingestion)
   - Proper metadata (query, seed entities, revision)

**Step 2: Implement EntityExtractor**

Simple keyword extraction: split query into words, normalize, filter stopwords.

```scala
object EntityExtractor {
  private val stopwords = Set("how", "does", "the", "is", "a", "an", "what", "when", "where", "why", "do", "it")

  def extract(query: String): Vector[String] = {
    query.toLowerCase
      .split("[\\s,;.!?]+")
      .map(_.trim)
      .filter(w => w.nonEmpty && !stopwords.contains(w))
      .toVector
      .distinct
  }
}
```

**Step 3: Implement GraphSeeder**

Takes keywords → searches graph for matching nodes → returns seed IDs.

```scala
class GraphSeeder(queryApi: GraphQueryApi) {
  def seed(tenant: TenantId, terms: Vector[String],
           asOfRev: Option[Rev]): IO[Vector[GraphNode]] =
    terms.traverse(term => queryApi.searchNodes(tenant, term)).map(_.flatten.distinct)
}
```

**Step 4: Implement GraphExpander**

Takes seed nodes → expands 1-2 hops → returns subgraph.

```scala
class GraphExpander(queryApi: GraphQueryApi) {
  def expand(tenant: TenantId, seeds: Vector[NodeId], hops: Int,
             predicates: Option[Set[String]],
             asOfRev: Option[Rev]): IO[ExpandResult]
}
```

**Step 5: Implement ClaimCollector**

Gathers all claims attached to nodes in the expanded subgraph.

```scala
class ClaimCollector(queryApi: GraphQueryApi) {
  def collect(tenant: TenantId, nodeIds: Vector[NodeId]): IO[Vector[Claim]]
}
```

**Step 6: Implement ContextRanker**

Sorts claims by confidence descending, groups by entity.

**Step 7: Implement ContextService**

Orchestrates the full pipeline: extract → seed → expand → collect claims → score → detect conflicts → rank → assemble StructuredContext.

```scala
class ContextService(
  queryApi:         GraphQueryApi,
  seeder:           GraphSeeder,
  expander:         GraphExpander,
  claimCollector:   ClaimCollector,
  confidenceScorer: ConfidenceScorer,
  conflictDetector: ConflictDetector,
  ranker:           ContextRanker
) {
  def query(tenant: TenantId, question: String,
            asOfRev: Option[Rev] = None): IO[StructuredContext]
}
```

**Step 8: Run tests, verify pass**

**Step 9: Commit**

```bash
git commit -m "feat: add context service with entity extraction, seeding, expansion, and ranking"
```

---

## Task 8: Confidence Scorer

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/context/ConfidenceScorer.scala`
- Test: `memory-layer/src/test/scala/ix/memory/context/ConfidenceScorerSpec.scala`

**Step 1: Write the failing test**

```scala
class ConfidenceScorerSpec extends AnyFlatSpec with Matchers {

  val scorer = new ConfidenceScorer()

  "ConfidenceScorer" should "score code-sourced claims higher than doc-sourced" in {
    val codeClaim = makeClaim(SourceType.Code)
    val docClaim  = makeClaim(SourceType.Doc)

    val codeScore = scorer.score(codeClaim, context)
    val docScore  = scorer.score(docClaim, context)

    codeScore.score should be > docScore.score
  }

  it should "penalize claims with conflicts" in {
    val claim = makeClaim(SourceType.Code)
    val noConflict = scorer.score(claim, contextWithoutConflict)
    val withConflict = scorer.score(claim, contextWithConflict)

    noConflict.score should be > withConflict.score
  }

  it should "boost claims with corroboration" in {
    val claim = makeClaim(SourceType.Code)
    val single = scorer.score(claim, contextWith1Source)
    val corroborated = scorer.score(claim, contextWith3Sources)

    corroborated.score should be > single.score
  }

  it should "provide explainable breakdown" in {
    val claim = makeClaim(SourceType.Code)
    val result = scorer.score(claim, context)

    result.baseAuthority.reason should include("code")
    result.score should be > 0.0
    result.score should be <= 1.0
  }
}
```

**Step 2: Implement ConfidenceScorer**

Implements the formula from the design doc:
- `baseAuthority` from `SourceType.baseAuthority(claim.provenance.sourceType)`
- `verification` from test coverage data (default 1.0 for Phase 1)
- `recency` from revision distance + source staleness check
- `corroboration` from count of agreeing sources
- `conflictPenalty` from conflict presence and relative authority

```scala
class ConfidenceScorer {
  def score(claim: Claim, ctx: ScoringContext): ConfidenceBreakdown = {
    val base = Factor(
      SourceType.baseAuthority(claim.provenance.sourceType),
      s"${claim.provenance.sourceType}, ${claim.provenance.extractor}"
    )
    val verif = Factor(1.0, "no verification data available")
    val recency = computeRecency(claim, ctx.latestRev, ctx.sourceChanged)
    val corr = computeCorroboration(claim, ctx.corroboratingCount)
    val conflict = computeConflictPenalty(claim, ctx.conflictState)
    ConfidenceBreakdown(base, verif, recency, corr, conflict)
  }
}

case class ScoringContext(
  latestRev:          Rev,
  sourceChanged:      Boolean,   // Has the source file changed since observation?
  corroboratingCount: Int,       // How many independent sources agree?
  conflictState:      ConflictState
)

sealed trait ConflictState
object ConflictState {
  case object None                     extends ConflictState
  case object ExistsHigherAuthority    extends ConflictState
  case object ExistsLowerAuthority     extends ConflictState
  case object ResolvedFor              extends ConflictState
  case object ResolvedAgainst          extends ConflictState
}
```

**Step 3: Run tests, verify pass**

**Step 4: Commit**

```bash
git commit -m "feat: add confidence scorer with explainable breakdowns"
```

---

## Task 9: Conflict Detector

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/conflict/ConflictDetector.scala`
- Create: `memory-layer/src/main/scala/ix/memory/conflict/ConflictService.scala`
- Test: `memory-layer/src/test/scala/ix/memory/conflict/ConflictDetectorSpec.scala`

**Step 1: Write the failing test**

Test should:
- Given two claims on the same entity with contradictory statements
- ConflictDetector identifies them as conflicting
- Creates a ConflictSet with both candidates
- Generates a recommendation based on authority ranking

**Step 2: Implement ConflictDetector**

Phase 1 conflict detection: simple heuristic — two claims on the same entity with different values for the same attribute or contradictory statements.

```scala
class ConflictDetector {
  def detect(claims: Vector[ScoredClaim]): Vector[ConflictReport] = {
    // Group claims by entity_id
    // Within each group, find pairs where statements are contradictory
    // For now: same entity, different statement, both ACTIVE
    // Generate ConflictReport with recommendation based on confidence
  }
}
```

**Step 3: Implement ConflictService**

Wraps ConflictDetector + persistence of ConflictSets to DB + resolution API.

```scala
class ConflictService(queryApi: GraphQueryApi, writeApi: GraphWriteApi) {
  def detectAndStore(tenant: TenantId, claims: Vector[ScoredClaim]): IO[Vector[ConflictReport]]
  def listConflicts(tenant: TenantId, status: Option[ConflictStatus]): IO[Vector[ConflictSet]]
  def resolve(tenant: TenantId, conflictId: ConflictId, winnerClaimId: ClaimId): IO[Rev]
}
```

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat: add conflict detection and resolution service"
```

---

## Task 10: HTTP API Routes

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/Routes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/ContextRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/IngestionRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/EntityRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/DiffRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/ConflictRoutes.scala`
- Create: `memory-layer/src/main/scala/ix/memory/api/ErrorHandler.scala`
- Test: `memory-layer/src/test/scala/ix/memory/api/RoutesSpec.scala`

**Step 1: Write the failing test**

Test with http4s test client:

```scala
class RoutesSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  "POST /v1/context" should "return structured context" in {
    // Build the full app in-memory
    // POST /v1/context with { "query": "billing retry", "tenant": "test" }
    // Expect 200 with StructuredContext JSON
  }

  "POST /v1/ingest" should "accept a file path and return ingestion result" in {
    // POST /v1/ingest with { "path": "/tmp/test.py", "tenant": "test" }
    // Expect 200 with { patches_applied, new_rev, entities_created }
  }

  "GET /v1/entity/:id" should "return entity with claims and edges" in {
    // After ingesting, GET a known entity
    // Expect 200 with node, claims, edges, provenance
  }

  "GET /v1/health" should "return ok" in {
    // GET /v1/health
    // Expect 200 with { "status": "ok" }
  }
}
```

**Step 2: Implement routes**

Endpoints:

| Method | Path | Handler | Description |
|--------|------|---------|-------------|
| GET | /v1/health | HealthRoute | Health check |
| POST | /v1/context | ContextRoutes | Query graph for structured context |
| POST | /v1/ingest | IngestionRoutes | Ingest source files |
| GET | /v1/entity/:id | EntityRoutes | Get entity with claims + edges |
| POST | /v1/diff | DiffRoutes | Diff between revisions |
| GET | /v1/conflicts | ConflictRoutes | List conflicts |
| POST | /v1/conflicts/:id/resolve | ConflictRoutes | Resolve a conflict |
| POST | /v1/provenance/:id | EntityRoutes | Trace provenance chain |

Request/response models:

```scala
// POST /v1/context
case class ContextRequest(query: String, tenant: String, asOfRev: Option[Long])
// Response: StructuredContext

// POST /v1/ingest
case class IngestRequest(path: String, tenant: String, language: Option[String], recursive: Option[Boolean])
case class IngestResponse(filesProcessed: Int, patchesApplied: Int, entitiesCreated: Int, latestRev: Long)

// POST /v1/conflicts/:id/resolve
case class ResolveRequest(winnerClaimId: String)
```

**Step 3: Implement ErrorHandler**

Map domain errors to HTTP status codes (same pattern as SD_Query_Engine).

**Step 4: Run tests, verify pass**

**Step 5: Commit**

```bash
git commit -m "feat: add HTTP API routes for context, ingestion, entity, diff, and conflicts"
```

---

## Task 11: Main Server Wiring

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/Main.scala`
- Test: Manual smoke test

**Step 1: Implement Main.scala**

Wire everything together using Cats Effect Resource composition:

```scala
package ix.memory

import cats.effect.{IO, IOApp, Resource}
import org.http4s.ember.server.EmberServerBuilder
import org.http4s.server.Router
import com.comcast.ip4s._

object Main extends IOApp.Simple {
  override def run: IO[Unit] = {
    val serverResource = for {
      // 1. ArangoDB client
      arangoClient <- ArangoClient.resource(
        host     = sys.env.getOrElse("ARANGO_HOST", "localhost"),
        port     = sys.env.getOrElse("ARANGO_PORT", "8529").toInt,
        database = sys.env.getOrElse("ARANGO_DATABASE", "ix_memory"),
        user     = sys.env.getOrElse("ARANGO_USER", "root"),
        password = sys.env.getOrElse("ARANGO_PASSWORD", "")
      )
      _ <- Resource.eval(arangoClient.ensureSchema())

      // 2. Core APIs
      writeApi = ArangoGraphWriteApi(arangoClient)
      queryApi = ArangoGraphQueryApi(arangoClient)

      // 3. Services
      parserRouter     = ParserRouter()
      ingestionService = IngestionService(parserRouter, writeApi)
      seeder           = GraphSeeder(queryApi)
      expander         = GraphExpander(queryApi)
      claimCollector   = ClaimCollector(queryApi)
      confidenceScorer = ConfidenceScorer()
      conflictDetector = ConflictDetector()
      ranker           = ContextRanker()
      contextService   = ContextService(queryApi, seeder, expander,
                           claimCollector, confidenceScorer,
                           conflictDetector, ranker)
      conflictService  = ConflictService(queryApi, writeApi)

      // 4. HTTP routes
      routes = Routes.all(contextService, ingestionService,
                          queryApi, conflictService)

      // 5. Server
      server <- EmberServerBuilder
        .default[IO]
        .withHost(host"0.0.0.0")
        .withPort(
          Port.fromInt(sys.env.getOrElse("PORT", "8090").toInt)
            .getOrElse(port"8090"))
        .withHttpApp(Router("/" -> routes).orNotFound)
        .build
    } yield server

    serverResource.use { server =>
      IO.println(s"Ix Memory Layer running at ${server.address}") *> IO.never
    }
  }
}
```

**Step 2: Smoke test**

Run: `sbt "memory-layer/run"`
Expected: Server starts on port 8090

Test endpoints:
```bash
curl http://localhost:8090/v1/health
# {"status":"ok"}

curl -X POST http://localhost:8090/v1/ingest \
  -H "Content-Type: application/json" \
  -d '{"path":"/tmp/test.py","tenant":"test"}'

curl -X POST http://localhost:8090/v1/context \
  -H "Content-Type: application/json" \
  -d '{"query":"billing retry","tenant":"test"}'
```

**Step 3: Commit**

```bash
git commit -m "feat: add Main server wiring — Memory Layer fully operational"
```

---

## Task 12: End-to-End Integration Test

**Files:**
- Create: `memory-layer/src/test/scala/ix/memory/EndToEndSpec.scala`
- Create: `memory-layer/src/test/resources/fixtures/sample_project/billing_service.py`
- Create: `memory-layer/src/test/resources/fixtures/sample_project/config.yaml`

**Step 1: Write the full end-to-end test**

```scala
class EndToEndSpec extends AsyncFlatSpec with AsyncIOSpec with Matchers {

  "Ix Memory Layer" should "ingest Python code and answer queries with provenance" in {
    // 1. Start ArangoDB client + all services
    // 2. Ingest sample_project/billing_service.py
    // 3. Query "How does billing retry?"
    // 4. Verify:
    //    - StructuredContext contains nodes for BillingService, retry_handler
    //    - Claims are present with provenance pointing to billing_service.py
    //    - Confidence scores are computed with explainable breakdowns
    //    - Metadata shows correct seed entities and revision
  }

  it should "detect conflicts between contradictory sources" in {
    // 1. Ingest billing_service.py (says retry 3 times in code)
    // 2. Manually commit a patch asserting "retries 5 times" from README
    // 3. Query about retries
    // 4. Verify conflict is detected and reported
    // 5. Verify code-sourced claim has higher confidence
  }

  it should "support time-travel queries" in {
    // 1. Ingest file at rev N
    // 2. Modify and re-ingest at rev N+1
    // 3. Query asOfRev=N → old state
    // 4. Query asOfRev=N+1 → new state
  }

  it should "be idempotent on re-ingestion" in {
    // 1. Ingest billing_service.py → rev R1
    // 2. Ingest same file again (no changes) → rev R1 (idempotent)
    // 3. Node count should not increase
  }
}
```

**Step 2: Run tests, verify pass**

Run: `sbt "memory-layer/testOnly ix.memory.EndToEndSpec"`
Expected: All integration tests pass

**Step 3: Commit**

```bash
git commit -m "feat: add end-to-end integration tests for full ingestion-to-query pipeline"
```

---

## Summary

| Task | Component | Depends On |
|------|-----------|------------|
| 1 | Project scaffold | — |
| 2 | Core data model | 1 |
| 3 | ArangoDB client + schema | 1 |
| 4 | Graph write API (patch commit) | 2, 3 |
| 5 | Graph query API | 2, 3 |
| 6 | Ingestion (tree-sitter Python) | 2, 4 |
| 7 | Context service (query pipeline) | 5, 8, 9 |
| 8 | Confidence scorer | 2 |
| 9 | Conflict detector | 2 |
| 10 | HTTP API routes | 6, 7 |
| 11 | Main server wiring | 10 |
| 12 | End-to-end integration test | 11 |

**Critical path:** 1 → 2 → 3 → 4 → 5 → 7 → 10 → 11 → 12
**Parallel tracks:** Tasks 8 and 9 can be built in parallel with Tasks 4-5. Task 6 can be built in parallel with Task 5.
