# Stabilize and Optimize Existing Ix Workflows — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix broken rank/inventory commands, make JSON mode fully strict, improve search defaults for agent safety.

**Architecture:** Add a `POST /v1/list` backend route exposing the existing `findNodesByKind()` method. Add `listByKind()` to the CLI client. Rewire rank and inventory to use it. Audit and fix JSON stdout leaks. Tighten search defaults.

**Tech Stack:** Scala (backend route), TypeScript (CLI), vitest

---

### Task 1: Add POST /v1/list backend route

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/ListRoutes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/api/Routes.scala`

**Step 1: Create ListRoutes.scala**

Create `memory-layer/src/main/scala/ix/memory/api/ListRoutes.scala`:

```scala
package ix.memory.api

import cats.effect.IO
import io.circe.Decoder
import io.circe.generic.semiauto.deriveDecoder
import io.circe.syntax._
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphQueryApi
import ix.memory.model._

case class ListRequest(
  kind: String,
  limit: Option[Int] = None
)

object ListRequest {
  implicit val decoder: Decoder[ListRequest] = deriveDecoder[ListRequest]
}

class ListRoutes(queryApi: GraphQueryApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "list" =>
      (for {
        body  <- req.as[ListRequest]
        kind  <- IO.fromEither(
                   NodeKind.decoder.decodeJson(io.circe.Json.fromString(body.kind))
                     .left.map(e => new IllegalArgumentException(s"Unknown kind: ${body.kind}"))
                 )
        nodes <- queryApi.findNodesByKind(kind, body.limit.getOrElse(200))
        resp  <- Ok(nodes.asJson)
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
```

**Step 2: Wire into Routes.scala**

In `memory-layer/src/main/scala/ix/memory/api/Routes.scala`:

Add after `val patchCommitRoutes` (line 45):
```scala
    val listRoutes          = new ListRoutes(queryApi).routes
```

Add `listRoutes` to the combinator chain on lines 47-50:
```scala
    health <+> contextRoutes <+> ingestionRoutes <+> entityRoutes <+>
      diffRoutes <+> conflictRoutes <+> decideRoutes <+> searchRoutes <+>
      truthRoutes <+> patchRoutes <+> decisionListRoutes <+> expandRoutes <+>
      statsRoutes <+> patchCommitRoutes <+> listRoutes
```

**Step 3: Verify backend compiles**

```bash
cd memory-layer && sbt compile
```

**Step 4: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/api/ListRoutes.scala memory-layer/src/main/scala/ix/memory/api/Routes.scala
git commit -m "feat: add POST /v1/list endpoint — list entities by kind"
```

---

### Task 2: Add listByKind to CLI client

**Files:**
- Modify: `ix-cli/src/client/api.ts`

**Step 1: Add listByKind method**

In `ix-cli/src/client/api.ts`, add after the `search` method (after line 56):

```typescript
  async listByKind(
    kind: string,
    opts?: { limit?: number }
  ): Promise<GraphNode[]> {
    return this.post("/v1/list", {
      kind,
      limit: opts?.limit,
    });
  }
```

**Step 2: Remove stray console.log**

In `ix-cli/src/client/api.ts` line 19, remove:
```typescript
    console.log("CLI depth:", opts?.depth);
```

**Step 3: Verify build**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add ix-cli/src/client/api.ts
git commit -m "feat: add listByKind client method, remove stray console.log"
```

---

### Task 3: Fix inventory to use listByKind

**Files:**
- Modify: `ix-cli/src/cli/commands/inventory.ts`

**Step 1: Replace search("") with listByKind**

In `ix-cli/src/cli/commands/inventory.ts`, replace lines 27-30:

```typescript
      // OLD:
      let nodes = await client.search("", {
        limit,
        kind: opts.kind,
      });
```

With:

```typescript
      let nodes = await client.listByKind(opts.kind, { limit });
```

No other changes needed — the rest of the command (path filtering, JSON output, text output) stays the same.

**Step 2: Verify build**

```bash
cd ix-cli && npm run build && npm test
```

**Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/inventory.ts
git commit -m "fix: inventory uses listByKind instead of empty-string search"
```

---

### Task 4: Fix rank to use listByKind

**Files:**
- Modify: `ix-cli/src/cli/commands/rank.ts`

**Step 1: Replace search("") with listByKind**

In `ix-cli/src/cli/commands/rank.ts`, replace line 58:

```typescript
        // OLD:
        const allNodes = await client.search("", { limit: 200, kind: opts.kind });
```

With:

```typescript
        const allNodes = await client.listByKind(opts.kind, { limit: 200 });
```

No other changes needed.

**Step 2: Verify build**

```bash
cd ix-cli && npm run build && npm test
```

**Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/rank.ts
git commit -m "fix: rank uses listByKind instead of empty-string search"
```

---

### Task 5: Tighten search defaults

**Files:**
- Modify: `ix-cli/src/cli/commands/search.ts`

**Step 1: Lower default limit and add unfiltered warning**

In `ix-cli/src/cli/commands/search.ts`:

Change line 10 default limit from "20" to "10":
```typescript
    .option("--limit <n>", "Max results", "10")
```

After the `formatNodes(nodes, opts.format)` call (line 26), add a diagnostic when format is JSON and no kind filter:

Replace lines 20-27 with:

```typescript
      const client = new IxClient(getEndpoint());
      const limit = parseInt(opts.limit, 10);
      const nodes = await client.search(term, {
        limit,
        kind: opts.kind,
        language: opts.language,
        asOfRev: opts.asOf ? parseInt(opts.asOf, 10) : undefined,
      });

      if (opts.format === "json") {
        const diagnostics: { code: string; message: string }[] = [];
        if (!opts.kind) {
          diagnostics.push({
            code: "unfiltered_search",
            message: "Results may be broad. Use --kind to filter.",
          });
        }
        console.log(JSON.stringify({
          results: nodes.map((n) => ({
            id: n.id,
            name: n.name || (n.attrs as any)?.name || "(unnamed)",
            kind: n.kind,
            path: n.provenance?.sourceUri ?? undefined,
          })),
          summary: { count: nodes.length },
          diagnostics,
        }, null, 2));
      } else {
        formatNodes(nodes, opts.format);
      }
```

Add the import for formatNodes stays as-is.

**Step 2: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/search.ts
git commit -m "feat: tighten search defaults — lower limit, add unfiltered_search diagnostic"
```

---

### Task 6: Update documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`

**Step 1: Update AGENTS.md**

In the "Start here — high-level workflow commands" section, ensure rank and inventory are listed with notes that they now work properly.

Add to the "When to use which" section:
```
- "List all classes" → `ix inventory --kind class`
- "What are the most critical methods?" → `ix rank --by callers --kind method --top 10`
```

In the low-level primitives section, add a note to search:
```
# Always use --kind with search to get bounded results
ix search <term> --kind <kind> --format json --limit 10
```

**Step 2: Update CLAUDE.md**

In the "Best Practices" section, add:
```
- Always use `--kind` with `ix search` to get bounded results
- Use `ix inventory` instead of `ix search ""` for listing entities by kind
```

**Step 3: Update README.md**

Ensure the Core Usage section mentions `--kind` with search examples.

**Step 4: Verify build**

```bash
cd ix-cli && npm run build && npm test
```

**Step 5: Commit**

```bash
git add AGENTS.md CLAUDE.md README.md
git commit -m "docs: update docs for stabilization — rank/inventory working, search best practices"
```
