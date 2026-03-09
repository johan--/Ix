# Stabilize Phase 2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Optimize diff with server-side summary + bounded defaults, cap fallback output, fix remaining JSON stdout leaks.

**Architecture:** Add `getDiffSummary()` to backend trait + ArangoDB implementation. Extend `DiffRequest` with `summary` and `limit` fields. Cap callers/locate text fallback to 10 results. Fix 4 CLI files with stdout leaks.

**Tech Stack:** Scala (backend), TypeScript (CLI), vitest

---

### Task 1: Add getDiffSummary to backend

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`

**Step 1: Add trait method**

In `memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala`, add after `getChangedEntities` (line 21):

```scala
  def getDiffSummary(fromRev: Rev, toRev: Rev): IO[Map[String, Int]]
```

**Step 2: Implement in ArangoGraphQueryApi**

In `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala`, add after the `getChangedEntities` method (after line 306):

```scala
  override def getDiffSummary(fromRev: Rev, toRev: Rev): IO[Map[String, Int]] = {
    val aql = """
      FOR n IN nodes
        FILTER n.created_rev > @fromRev AND n.created_rev <= @toRev
        COLLECT logicalId = n.logical_id
        LET atFrom = FIRST(
          FOR x IN nodes
            FILTER x.logical_id == logicalId
              AND x.created_rev <= @fromRev
              AND (x.deleted_rev == null OR @fromRev < x.deleted_rev)
            RETURN x
        )
        LET atTo = FIRST(
          FOR x IN nodes
            FILTER x.logical_id == logicalId
              AND x.created_rev <= @toRev
              AND (x.deleted_rev == null OR @toRev < x.deleted_rev)
            RETURN x
        )
        LET changeType = (atFrom == null ? "added" : (atTo.deleted_rev != null ? "removed" : "modified"))
        COLLECT type = changeType WITH COUNT INTO cnt
        RETURN { type: type, cnt: cnt }
    """
    client.query(aql, Map(
      "fromRev" -> Long.box(fromRev.value).asInstanceOf[AnyRef],
      "toRev"   -> Long.box(toRev.value).asInstanceOf[AnyRef]
    )).map { results =>
      results.flatMap { json =>
        for {
          t <- json.hcursor.downField("type").as[String].toOption
          c <- json.hcursor.downField("cnt").as[Int].toOption
        } yield t -> c
      }.toMap
    }
  }
```

**Step 3: Verify backend compiles**

```bash
cd memory-layer && sbt compile
```

**Step 4: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/GraphQueryApi.scala memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala
git commit -m "feat: add getDiffSummary — server-side diff counting without full hydration"
```

---

### Task 2: Extend DiffRoutes with summary and limit support

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/api/DiffRoutes.scala`

**Step 1: Add fields to DiffRequest**

Replace the `DiffRequest` case class (line 15):

```scala
case class DiffRequest(
  fromRev:  Long,
  toRev:    Long,
  entityId: Option[String] = None,
  summary:  Option[Boolean] = None,
  limit:    Option[Int] = None
)
```

**Step 2: Add DiffSummaryResponse**

Add after `DiffResponse` (after line 38):

```scala
case class DiffSummaryResponse(
  fromRev: Long,
  toRev: Long,
  summary: Map[String, Int],
  total: Int
)

object DiffSummaryResponse {
  implicit val encoder: Encoder[DiffSummaryResponse] = deriveEncoder[DiffSummaryResponse]
}
```

**Step 3: Add summary branch to route handler**

Replace the route handler body (lines 44-76) with:

```scala
  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "diff" =>
      (for {
        body     <- req.as[DiffRequest]
        _        <- IO.raiseWhen(body.fromRev >= body.toRev)(
          new IllegalArgumentException("fromRev must be less than toRev")
        )
        resp     <- if (body.summary.getOrElse(false)) {
          // Server-side summary: counts only, no node hydration
          queryApi.getDiffSummary(Rev(body.fromRev), Rev(body.toRev)).flatMap { counts =>
            val total = counts.values.sum
            Ok(DiffSummaryResponse(body.fromRev, body.toRev, counts, total))
          }
        } else {
          val effectiveLimit = body.limit.getOrElse(100)
          body.entityId match {
            case Some(eidStr) =>
              for {
                eid    <- IO.fromTry(scala.util.Try(UUID.fromString(eidStr))).map(NodeId(_))
                result <- diffEntity(eid, Rev(body.fromRev), Rev(body.toRev))
              } yield result.toVector
            case None =>
              queryApi.getChangedEntities(Rev(body.fromRev), Rev(body.toRev)).map { pairs =>
                pairs.map { case (atTo, atFromOpt) =>
                  val changeType = if (atFromOpt.isEmpty) "added"
                                   else if (atTo.deletedRev.isDefined) "removed"
                                   else "modified"
                  val summary = atFromOpt.map { atFrom =>
                    diffAttrs(atFrom.attrs, atTo.attrs)
                  }
                  DiffEntry(
                    entityId   = atTo.id,
                    changeType = changeType,
                    atFromRev  = atFromOpt,
                    atToRev    = Some(atTo),
                    summary    = summary.filter(_.nonEmpty)
                  )
                }
              }
          }
        }.flatMap {
          case resp: IO[org.http4s.Response[IO]] @unchecked => resp
          case changes: Vector[DiffEntry] @unchecked =>
            val effectiveLimit = body.limit.getOrElse(100)
            val totalChanges = changes.size
            val truncated = totalChanges > effectiveLimit
            val limited = if (truncated) changes.take(effectiveLimit) else changes
            Ok(DiffResponse(body.fromRev, body.toRev, limited, truncated, totalChanges))
        }
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
```

Actually, let me simplify. The branching is cleaner as two separate paths:

Replace the entire route handler (lines 42-77) with:

```scala
  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "diff" =>
      (for {
        body <- req.as[DiffRequest]
        _    <- IO.raiseWhen(body.fromRev >= body.toRev)(
          new IllegalArgumentException("fromRev must be less than toRev")
        )
        resp <- if (body.summary.getOrElse(false)) {
          // Summary mode: server-side counting, no node hydration
          for {
            counts <- queryApi.getDiffSummary(Rev(body.fromRev), Rev(body.toRev))
            r      <- Ok(DiffSummaryResponse(body.fromRev, body.toRev, counts, counts.values.sum))
          } yield r
        } else {
          // Full diff mode with optional limit
          val effectiveLimit = body.limit.getOrElse(100)
          val changesIO = body.entityId match {
            case Some(eidStr) =>
              for {
                eid    <- IO.fromTry(scala.util.Try(UUID.fromString(eidStr))).map(NodeId(_))
                result <- diffEntity(eid, Rev(body.fromRev), Rev(body.toRev))
              } yield result.toVector
            case None =>
              queryApi.getChangedEntities(Rev(body.fromRev), Rev(body.toRev)).map { pairs =>
                pairs.map { case (atTo, atFromOpt) =>
                  val changeType = if (atFromOpt.isEmpty) "added"
                                   else if (atTo.deletedRev.isDefined) "removed"
                                   else "modified"
                  val attrSummary = atFromOpt.map { atFrom =>
                    diffAttrs(atFrom.attrs, atTo.attrs)
                  }
                  DiffEntry(
                    entityId   = atTo.id,
                    changeType = changeType,
                    atFromRev  = atFromOpt,
                    atToRev    = Some(atTo),
                    summary    = attrSummary.filter(_.nonEmpty)
                  )
                }
              }
          }
          for {
            allChanges <- changesIO
            totalCount  = allChanges.size
            truncated   = totalCount > effectiveLimit
            limited     = if (truncated) allChanges.take(effectiveLimit) else allChanges
            r          <- Ok(DiffResponse(body.fromRev, body.toRev, limited, truncated, totalCount))
          } yield r
        }
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
```

**Step 4: Update DiffResponse to include truncation metadata**

Replace the `DiffResponse` case class (line 34):

```scala
case class DiffResponse(
  fromRev:      Long,
  toRev:        Long,
  changes:      Vector[DiffEntry],
  truncated:    Boolean,
  totalChanges: Int
)
```

**Step 5: Verify backend compiles**

```bash
cd memory-layer && sbt compile
```

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/api/DiffRoutes.scala
git commit -m "feat: diff supports server-side summary and limit with truncation metadata"
```

---

### Task 3: Update CLI diff client and command

**Files:**
- Modify: `ix-cli/src/client/api.ts`
- Modify: `ix-cli/src/cli/commands/diff.ts`

**Step 1: Update client diff method**

In `ix-cli/src/client/api.ts`, replace the `diff` method (lines 139-145):

```typescript
  async diff(
    fromRev: number,
    toRev: number,
    opts?: { entityId?: string; summary?: boolean; limit?: number }
  ): Promise<unknown> {
    return this.post("/v1/diff", {
      fromRev,
      toRev,
      entityId: opts?.entityId,
      summary: opts?.summary,
      limit: opts?.limit,
    });
  }
```

**Step 2: Rewrite diff command**

Replace the entire contents of `ix-cli/src/cli/commands/diff.ts`:

```typescript
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import { getEndpoint } from "../config.js";
import { formatDiff } from "../format.js";

export function registerDiffCommand(program: Command): void {
  program
    .command("diff <fromRev> <toRev>")
    .description("Show diff between two revisions")
    .option("--entity <id>", "Filter by entity ID")
    .option("--summary", "Show compact summary only (server-side, fast)")
    .option("--limit <n>", "Max changes to return (default 100)")
    .option("--full", "Return all changes (no limit)")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .action(async (fromRev: string, toRev: string, opts: {
      entity?: string; summary?: boolean; limit?: string; full?: boolean; format: string;
    }) => {
      const client = new IxClient(getEndpoint());
      const from = parseInt(fromRev, 10);
      const to = parseInt(toRev, 10);

      if (opts.summary) {
        // Server-side summary — no full payload
        const result: any = await client.diff(from, to, { summary: true });

        if (opts.format === "json") {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const s = result.summary || {};
          console.log(chalk.cyan.bold(`\nDiff: rev ${result.fromRev} → ${result.toRev}`));
          if (s.added) console.log(`  ${chalk.green("Added:")}    ${s.added}`);
          if (s.modified) console.log(`  ${chalk.yellow("Modified:")} ${s.modified}`);
          if (s.removed) console.log(`  ${chalk.red("Removed:")}  ${s.removed}`);
          if (!s.added && !s.modified && !s.removed) console.log(chalk.dim("  No changes."));
          console.log(`  ${chalk.dim("Total:")}    ${result.total}`);
          console.log();
        }
        return;
      }

      // Full diff mode
      const limit = opts.full ? undefined : (opts.limit ? parseInt(opts.limit, 10) : undefined);
      const result: any = await client.diff(from, to, {
        entityId: opts.entity,
        limit,
      });

      if (opts.format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        if (result.truncated) {
          console.log(chalk.yellow(`Showing ${result.changes.length} of ${result.totalChanges} changes. Use --full to see all.\n`));
        }
        formatDiff(result, "text");
      }
    });
}
```

**Step 3: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add ix-cli/src/client/api.ts ix-cli/src/cli/commands/diff.ts
git commit -m "feat: CLI diff supports --summary (server-side), --limit, --full flags"
```

---

### Task 4: Cap callers text fallback to 10 results

**Files:**
- Modify: `ix-cli/src/cli/commands/callers.ts`

**Step 1: Add stderr import and cap fallback results**

Replace the entire text fallback block in `ix-cli/src/cli/commands/callers.ts` (lines 33-81):

```typescript
      if (result.nodes.length === 0) {
        // Fallback to text search
        try {
          const root = resolveWorkspaceRoot();
          const { stdout } = await execFileAsync("rg", [
            "--json", "--max-count", "10", target.name, root,
          ], { maxBuffer: 5 * 1024 * 1024 });

          const allTextResults: any[] = [];
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "match") {
                const data = parsed.data;
                allTextResults.push({
                  id: "",
                  kind: "text-match",
                  name: `${data.path?.text ?? ""}:${data.line_number ?? 0}`,
                  resolved: false,
                  path: data.path?.text ?? "",
                  line: data.line_number ?? 0,
                  attrs: { snippet: data.lines?.text?.trim() ?? "" },
                });
              }
            } catch { /* skip malformed lines */ }
          }

          const candidatesFound = allTextResults.length;
          const textResults = allTextResults.slice(0, 10);

          if (textResults.length > 0) {
            if (opts.format === "json") {
              console.log(JSON.stringify({
                results: textResults,
                resultSource: "text",
                resolvedTarget: target,
                summary: {
                  candidatesFound,
                  candidatesReturned: textResults.length,
                },
                diagnostics: [{
                  code: "text_fallback_used",
                  message: "No graph-backed callers found; showing bounded lexical candidates.",
                }],
              }, null, 2));
            } else {
              stderr(chalk.dim("No graph-backed callers found. Showing text-based candidate usages.\n"));
              for (const r of textResults) {
                const snippet = r.attrs?.snippet ?? "";
                console.log(`  ${chalk.dim(r.name)}  ${snippet}`);
              }
              if (candidatesFound > 10) {
                stderr(chalk.dim(`\n  (${candidatesFound} total candidates; showing 10)`));
              }
            }
            return;
          }
        } catch { /* ripgrep not available or no matches */ }

        // Both graph and text empty
        formatEdgeResults([], "callers", target.name, opts.format, target, "graph");
      } else {
        formatEdgeResults(result.nodes.slice(0, limit), "callers", target.name, opts.format, target, "graph");
      }
```

**Step 2: Add stderr import**

At the top of `ix-cli/src/cli/commands/callers.ts`, add to the imports (after line 8):

```typescript
import { stderr } from "../stderr.js";
```

**Step 3: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add ix-cli/src/cli/commands/callers.ts
git commit -m "fix: cap callers text fallback to 10 results, route warning to stderr"
```

---

### Task 5: Cap locate text results to 10

**Files:**
- Modify: `ix-cli/src/cli/commands/locate.ts`

**Step 1: Cap ripgrep results before merging**

In `ix-cli/src/cli/commands/locate.ts`, after the ripgrep parsing loop (after line 49, before the "Build results" comment), add:

```typescript
      // Cap text hits to prevent oversized output
      textHits = textHits.slice(0, 10);
```

**Step 2: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/locate.ts
git commit -m "fix: cap locate text results to 10 to prevent oversized output"
```

---

### Task 6: Fix remaining JSON stdout leaks

**Files:**
- Modify: `ix-cli/src/cli/commands/query.ts`
- Modify: `ix-cli/src/cli/commands/read.ts`
- Modify: `ix-cli/src/cli/commands/text.ts`

**Step 1: Fix query.ts — route deprecation to stderr**

Replace all `console.log` calls in the deprecation block (lines 15-34) of `ix-cli/src/cli/commands/query.ts`:

```typescript
import { stderr } from "../stderr.js";
```

Add import at top. Then replace lines 15-34:

```typescript
      stderr("\n\u26a0  ix query is DEPRECATED \u2014 broad NLP-style graph queries produce oversized, low-signal responses.");
      stderr("   Decompose your question into targeted commands instead:\n");
      stderr("  ix search <term>          Find entities by name/kind");
      stderr("  ix explain <symbol>       Structure, container, history, calls");
      stderr("  ix callers <symbol>       What calls a function (cross-file)");
      stderr("  ix callees <symbol>       What a function calls");
      stderr("  ix contains <symbol>      Members of a class/module");
      stderr("  ix imports <symbol>       What an entity imports");
      stderr("  ix imported-by <symbol>   What imports an entity");
      stderr("  ix depends <symbol>       Dependency impact analysis");
      stderr("  ix text <term>            Fast lexical search (ripgrep)");
      stderr("  ix read <target>          Read source code directly");
      stderr("  ix decisions              List design decisions");
      stderr("  ix history <entityId>     Provenance chain");
      stderr("  ix diff <from> <to>       Changes between revisions\n");
      if (!opts.unsafe) {
        stderr("Pass --unsafe to run anyway (not recommended).\n");
        return;
      }
      stderr("Running with --unsafe...\n");
```

**Step 2: Fix read.ts — use stderr()**

In `ix-cli/src/cli/commands/read.ts`, add import at top:

```typescript
import { stderr } from "../stderr.js";
```

Replace line 56:
```typescript
        stderr(`Could not resolve symbol: ${target}`);
```

Replace line 73:
```typescript
        stderr(`Source file not found: ${sourceUri ?? "(no provenance)"}`);
```

**Step 3: Fix text.ts — use stderr()**

In `ix-cli/src/cli/commands/text.ts`, add import at top:

```typescript
import { stderr } from "../stderr.js";
```

Replace line 65:
```typescript
          stderr("Error: ripgrep (rg) is not installed. Install it: https://github.com/BurntSushi/ripgrep#installation");
```

**Step 4: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 5: Commit**

```bash
git add ix-cli/src/cli/commands/query.ts ix-cli/src/cli/commands/read.ts ix-cli/src/cli/commands/text.ts
git commit -m "fix: route all remaining stdout leaks to stderr — query, read, text commands"
```

---

### Task 7: Update documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Step 1: Update AGENTS.md**

In the "Start here — high-level workflow commands" section, update the diff example:
```
ix diff <from> <to> --summary --format json   # Fast revision summary
```

In the "When to use which" section, add:
```
- "What changed between rev 5 and 10?" → `ix diff 5 10 --summary`
- "Show me all changes" → `ix diff 5 10 --full --format json`
```

In the diagnostic codes table, add:
```
| `truncated_diff` | Diff results were capped; use --full for all changes |
```

**Step 2: Update CLAUDE.md**

In the Best Practices section, add:
```
- Use `ix diff --summary` for broad revision comparisons (server-side, fast)
- Use `--full` only when you need every individual change
```

**Step 3: Verify build and tests**

```bash
cd ix-cli && npm run build && npm test
```

**Step 4: Commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: update docs for phase 2 — diff optimization, fallback bounding, JSON cleanup"
```
