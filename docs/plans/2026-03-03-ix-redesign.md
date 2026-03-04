# Ix Memory Layer — Redesign: Architecture & Design Spec

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the best possible persistent memory system for LLMs — one that makes the LLM genuinely smarter by giving it structured, time-aware, confidence-scored memory about an entire codebase. Focused on MCP + system prompts (not BYOK), optimized for improving LLM reasoning over time.

**Focus:** All memory capabilities are equally important — decision traceability, conflict detection, temporal awareness, session restoration, and provenance tracking all work together to create human-like memory. The user's objective/intent is the initial hypothesis; truth emerges as the event log accumulates verified observations aligned with that intent.

**Architecture:** Thin-client TypeScript CLI + MCP server → Scala Memory Layer HTTP API → ArangoDB, all containerized. Single-codebase system (no multi-tenancy). Enforcement via layered system: MCP instructions + CLAUDE.md + tool descriptions + minimal MCP Resources (~30 tokens). Context is traversed, not pre-loaded.

**Tech Stack:**
- **Memory Layer:** Scala 2.13, Cats Effect 3, http4s, Circe, ArangoDB Java Driver
- **CLI + MCP Server:** TypeScript, commander.js, @modelcontextprotocol/sdk
- **Database:** ArangoDB 3.12 (Docker), custom-built later
- **Packaging:** Docker Compose for backend, npm for CLI/MCP

---

## 0. What Ix Is

Ix is a **memory system for LLMs** that works like human memory.

**The system does not store facts. It stores observations about reality over time, plus evidence explaining why those observations exist.**

When a human remembers something, they don't just know "the billing service retries 3 times." They know:
- **When** they learned it (I read billing.py last Tuesday)
- **Who** told them (I saw it in the code vs. someone mentioned it in Slack)
- **How confident** they are (very sure — I read the source code)
- **Whether it's still true** (didn't that get refactored last week?)
- **If there's a conflict** (the docs say no retries, but the code says 3)

LLMs today have none of this. They have a context window that resets every conversation, and they guess from training data. **Ix gives the LLM structured, time-aware, provenance-backed memory so it stops guessing and starts knowing.**

### Core Principles

1. **Patch/Event Log = Source of Truth.** Normal databases store whether something exists. Ours stores patches that state who added something, why, what it replaced, and when it happened.
2. **The human prompt defines an initial intent hypothesis, and truth emerges as the event log accumulates verified observations aligned with that intent.**
3. **Every fact has time (Temporal Truth).** We don't just say if X is true — we say when it was true, when it became true, when it stopped being true. Helps with hallucinations.
4. **Provenance-first.** Every fact carries full provenance: who asserted it, from what source, using what extractor, when.
5. **Computed confidence.** Confidence scores are derived from provenance signals, never manually assigned. LLM-extracted nodes get lower confidence.
6. **Conflict detection.** When two patches disagree, the system surfaces the contradiction — it doesn't silently pick a winner.
7. **You can always answer:** who said this, when, based on what, and what did it replace?

### Source of Truth: The User's Objective

The user's input defines the **initial intent hypothesis** — what they're trying to accomplish. This is the anchor. Everything in the system serves this:

1. **User states objective** (e.g., "Build a billing service with retry logic")
2. **System ingests codebase** → observations about what exists
3. **Observations accumulate** → patches record who saw what, when, from where
4. **Truth emerges** → verified observations aligned with the intent rise in confidence
5. **Conflicts surface** → when observations contradict, the system flags them
6. **Decisions are recorded** → why choices were made, linking back to the intent

The system is for an **entire codebase** — there is no multi-tenancy or per-user isolation. Everyone working on the codebase sees the same graph, the same observations, the same truth.

### What We're NOT Building

- A chatbot
- A general knowledge graph
- A vector database
- A GitHub replacement

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  LLM (Claude Desktop / Claude Code)                                  │
│                                                                       │
│  CLAUDE.md rules + MCP instructions + Tool descriptions              │
│  + minimal MCP Resources (~30 tokens nudge)                          │
│  = LAYERED ENFORCEMENT (context is traversed, not pre-loaded)        │
└────────────────┬──────────────────────────────────────────────────────┘
                 │ MCP stdio protocol
                 ▼
┌────────────────────────────────────────────────────────┐
│  MCP Server (TypeScript, runs locally)                  │
│  Part of @ix/cli npm package                            │
│  ├── Session Manager (tracks working set)              │
│  ├── Tool Handlers (ix_query, ix_decide, etc.)         │
│  ├── Resource Provider (auto-inject context per turn)  │
│  ├── Prompt Builder (formats StructuredContext for LLM) │
│  └── Enforcement Rules (tool-level instructions)       │
└────────────────┬───────────────────────────────────────┘
                 │ HTTP (to localhost:8090)
                 ▼
┌────────────────────────────────────────────────────────┐  ┐
│  Memory Layer (Scala, Docker Container)                 │  │
│  Port 8090                                              │  │
│  ├── HTTP API (Routes)                                  │  │
│  ├── Context Pipeline (8-step query assembly)          │  │ Backend
│  ├── Ingestion Pipeline (parsers → patches → DB)       │  │ (Docker)
│  ├── Confidence Scoring Engine                          │  │
│  ├── Conflict Detection & Resolution                   │  │
│  └── Graph Access Layer (traits → ArangoDB impl)       │  │
└────────────────┬───────────────────────────────────────┘  │
                 │                                           │
                 ▼                                           │
┌────────────────────────────────────────────────────────┐  │
│  ArangoDB 3.12 (Docker Container)                       │  │
│  Port 8529                                              │  │
│  Collections: nodes, edges, claims, patches,            │  │
│               revisions, idempotency_keys               │  │
└────────────────────────────────────────────────────────┘  ┘

CLI (TypeScript, runs locally)
  ix init → start backend + configure project
  ix ingest → parse files → POST /v1/ingest
  ix query → POST /v1/context → formatted output
  ix decide → POST /v1/decide → record decision
```

### Why This Architecture

| Decision | Rationale |
|----------|-----------|
| **Thin client MCP/CLI** | MCP needs stdio access (local process). CLI needs local file access. Neither needs to be containerized. |
| **Memory Layer in Docker** | Contains all business logic. Single container, easy to deploy, matches SimplestData pattern. |
| **ArangoDB in Docker** | Separate container from Memory Layer. Data persists via volumes. Will be replaced with custom DB later — the trait-based API layer (`GraphWriteApi`/`GraphQueryApi`) makes this a swap. |
| **TypeScript for CLI/MCP** | Official MCP SDK is TypeScript. Largest contributor pool. npm distribution is standard. |
| **Scala for Memory Layer** | Already built in Phase 1. Cats Effect gives us safe concurrency. http4s is production-grade. No reason to rewrite. |
| **Minimal MCP Resources + strong rules** | ~30 tokens nudge reminds LLM Ix exists. Actual enforcement via MCP instructions + CLAUDE.md + tool descriptions. Context is traversed, not pre-loaded. |

---

## 2. Patch / Event Log Model

The event log is the source of truth. Every mutation is a **patch** — a record of an observation about reality.

### 2.1 GraphPatch (the atomic unit of truth)

```
GraphPatch = {
  patchId:    UUID             ← Unique ID for this observation (idempotency key)
  # No tenant — single codebase system. Multi-tenancy is not needed.
  actor:      String           ← WHO made this observation
                                  "tree-sitter-python/1.0" (parser)
                                  "claude-desktop/session-xyz" (LLM)
                                  "human/riley" (manual)
  timestamp:  Instant          ← WHEN (wall clock time)
  source: {
    uri:        String         ← WHAT was observed ("billing.py", "README.md", "decision://manual")
    hash:       String?        ← Content hash at observation time (staleness detection)
    extractor:  String         ← HOW extracted ("tree-sitter-python", "human-assertion")
    sourceType: SourceType     ← Authority level (Code=0.90, Doc=0.75, Human=0.85, LLM=0.40)
  }
  baseRev:    Rev              ← Optimistic concurrency ("I'm observing based on state at rev N")
  ops:        Vector[PatchOp]  ← WHAT was observed (mutations)
  replaces:   Vector[UUID]     ← What prior observations this supersedes
  intent:     String?          ← WHY ("Initial ingestion", "Developer confirmed retry")
}
```

### 2.2 Patch Operations

```
UpsertNode(id, kind, name, attrs)
  → "I observed this entity exists with these attributes"
  → Node is new: create row with created_rev = this_rev, deleted_rev = null
  → Node already exists WITH SAME attrs: no-op (idempotent)
  → Node already exists WITH DIFFERENT attrs: VERSION the node:
      1. Set deleted_rev = this_rev on the OLD row (seals it in time)
      2. Create NEW row: same logical id, new attrs, created_rev = this_rev
      3. DB key = "${id}_${created_rev}" (allows multiple rows per logical entity)
      4. Edges and claims still reference the logical id — they span versions
    This makes time-travel correct for attribute changes:
      Query at rev 5  → finds row where created_rev <= 5 AND (deleted_rev IS NULL OR 5 < deleted_rev)
      Query at rev 30 → finds the newer row
      Same entity, correct attrs at every revision.

UpsertEdge(id, src, dst, predicate, attrs)
  → "I observed this relationship exists"
  → Same versioning semantics as UpsertNode (tombstone + new row if attrs change)

DeleteNode(id)
  → "I observed this entity no longer exists"
  → Sets deleted_rev = this_rev on current row (TOMBSTONE — never physically deleted)

DeleteEdge(id)
  → Same tombstone semantics

AssertClaim(entityId, statement, value, confidence?)
  → "I'm asserting this fact about this entity"
  → Creates Claim node + HAS_CLAIM edge
  → Confidence is COMPUTED from provenance, not from this field

RetractClaim(claimId, reason)
  → "This claim is no longer true"
  → Claim remains for history, confidence drops to ~0
```

### 2.3 MVCC — How Time Works

Every node and edge has two revision fields:

```
created_rev: Long    ← When this entity came into existence
deleted_rev: Long?   ← When this entity ceased to exist (null = alive)
```

**Visibility rule:**
```
visible_at(R) = created_rev <= R AND (deleted_rev IS NULL OR R < deleted_rev)
```

**Timeline example:**
```
Rev 1:  BillingService created    (created_rev=1, deleted_rev=null)
        retry_payment created     (created_rev=1, deleted_rev=null)
        Claim: "max_retries=3"    (created_rev=1, deleted_rev=null)

Rev 5:  Claim: "does not retry"   (created_rev=5, deleted_rev=null)
        → CONFLICT detected

Rev 12: "does not retry" retracted (deleted_rev=12)
        "max_retries=3" confirmed  (verification multiplier → 1.1)

Rev 25: retry_payment deleted      (deleted_rev=25)
        retry_with_backoff created (created_rev=25)

Query at rev 1:  → sees original state
Query at rev 5:  → sees CONFLICT
Query at rev 12: → conflict resolved
Query at rev 25: → old function gone, new function exists
                   LLM sees: "retry_payment USED TO EXIST (rev 1-25)"
```

### 2.4 How Patches Replace Each Other

When a file is re-ingested after modification, the ingestion pipeline must FIND the old
patch to set `replaces`. This is done by querying:

```
getLatestPatchBySource(uri: String, extractor: String): IO[Option[GraphPatch]]
  → "Find the most recent patch with this source URI created by this extractor"
```

**Rules for `replaces`:**
- Only replaces patches with the **same source URI AND same extractor**
- A re-ingestion by tree-sitter replaces the previous tree-sitter ingestion of that file
- It does NOT replace manual human assertions about entities in that file
- If the content hash is unchanged → skip (idempotent, no new patch needed)
- If the content hash changed → create new patch with `replaces: [old-patch-id]`

```
Patch #001 (rev 1):
  source: billing.py, hash: "abc123", extractor: "tree-sitter-python"
  ops: [UpsertNode(retry_payment, {max_retries: 3})]

--- developer edits file ---

Ingestion pipeline:
  1. Query: getLatestPatchBySource("billing.py", "tree-sitter-python") → Patch #001
  2. Compare hashes: "abc123" ≠ "xyz789" → file changed
  3. Create new patch with replaces: ["patch-001"]

Patch #042 (rev 25):
  source: billing.py, hash: "xyz789", extractor: "tree-sitter-python"
  replaces: ["patch-001"]                 ← Supersedes old observation
  ops: [UpsertNode(retry_payment, {max_retries: 5, backoff: "exponential"})]

Result:
  - Patch #001 remains in event log (history preserved, still navigable)
  - Node versioned: old attrs sealed at rev 25, new attrs from rev 25 onward
  - Old claims from Patch #001 become STALE (source hash changed)
```

### 2.5 Deterministic Node IDs

```
NodeId = UUID.nameUUIDFromBytes("${filePath}:${entityName}".getBytes("UTF-8"))
```

This ensures:
- Re-ingesting the same file → same node IDs → UPSERTs not duplicates
- Two parsers observing the same entity → same node ID → observations link together
- Replay same patch log → get same graph (deterministic, enterprise feature)

### 2.6 Traditional DB vs Ix Event Log

```
Traditional DB:                    Ix Event Log:
═══════════════                    ════════════

retry_count = 3                    Patch #1 (rev 1, 2026-01-15, actor: tree-sitter)
                                     "retry_count = 3 observed in billing.py:45"
(Who set it? When?                   source: billing.py, hash: a1b2c3
 Was it ever different?
 Why? Unknown.)                    Patch #2 (rev 7, 2026-02-01, actor: markdown-parser)
                                     "does not retry observed in README.md:22"
                                     source: README.md, hash: d4e5f6
                                     → CONFLICT with Patch #1

                                   Patch #3 (rev 12, 2026-02-20, actor: human/riley)
                                     "retry_count = 3 confirmed by developer"
                                     → Resolves conflict, weakens README claim

                                   Patch #4 (rev 25, 2026-03-01, actor: tree-sitter)
                                     "retry_count = 5, backoff = exponential"
                                     replaces: Patch #1
                                     → Code changed, old observation superseded
```

---

## 3. Data Model (Schema)

### 3.1 Node Types

**Structural Nodes** (from code/AST parsing):

| Kind | Attributes | Source Authority |
|------|------------|-----------------|
| Module | name, path, language | Code (0.90) |
| File | path, language, hash, size | Code (0.90) |
| Class | name, file_path, line_start, line_end | Code (0.90) |
| Function | name, signature, file_path, line_start, line_end | Code (0.90) |
| Variable | name, type, scope | Code (0.90) |
| Config | path, format | Config (0.85) |
| ConfigEntry | key, value, type | Config (0.85) |
| Service | name, port, protocol | Code/Config |
| Endpoint | method, path, handler | Code (0.90) |

**Intent Nodes** (user-defined truth/objectives — part of the hierarchy):

| Kind | Attributes | Source Authority |
|------|------------|-----------------|
| Intent | statement, status (ACTIVE/SUPERSEDED/ABANDONED), parent_intent? | Human (0.85) if user-set, LLM (0.40) if LLM-proposed |

Intent nodes form a **hierarchy**: top-level intent → sub-intents → sub-sub-intents.
- User sets the root intent via `ix truth set "Build a scalable billing service"`
- User adds sub-intents via `ix truth add "Retry logic should handle transient failures"`
- LLM can propose sub-intents (lower confidence, 0.40) that become confirmed (0.85) when user approves
- Intents are versioned — `ix truth update` creates a new revision, old intent gets `deleted_rev` set
- LLM can time-travel through intents: "What was the objective at rev 10 vs now?"

```
Intent("Build a scalable billing service")         ← root, user-set, rev 1
  ├── CONTAINS → Intent("Handle transient failures")  ← sub-intent, user-set, rev 2
  │     └── CONTAINS → Intent("Max retries = 3")      ← sub-sub, LLM-proposed, rev 5
  ├── CONTAINS → Intent("Exponential backoff")         ← sub-intent, user-set, rev 3
  └── CONTAINS → Intent("Idempotent gateway calls")   ← sub-intent, user-set, rev 4
```

**Knowledge Nodes:**

| Kind | Attributes | Source Authority |
|------|------------|-----------------|
| Claim | statement, status (ACTIVE/STALE/RETRACTED) | Varies by source |
| Decision | title, rationale, alternatives_considered | Human (0.85) |
| ConflictSet | reason, status (OPEN/RESOLVED/DISMISSED), candidates[] | System-generated |

### 3.2 Common Node Fields

Every node:
```
id:          UUID (deterministic)
kind:        NodeKind enum
attrs:       JSON (kind-specific)
provenance:  { source_uri, source_hash, extractor, source_type, observed_at }
created_rev: Long (MVCC)
deleted_rev: Long? (MVCC, null = alive)
created_at:  Instant
updated_at:  Instant
```

### 3.3 Edge Types

**Structural Edges:**

| Predicate | From → To | Meaning |
|-----------|-----------|---------|
| DEFINES | Module/Class → Class/Function | Ownership |
| CONTAINS | File → Class/Function | Physical containment |
| CALLS | Function → Function | Call relationship |
| IMPORTS | File → Module/File | Import relationship |
| DEPENDS_ON | Service → Service | Service dependency |
| CONFIGURES | ConfigEntry → Service/Function | Configuration |
| EXPOSES | Service → Endpoint | API exposure |
| INHERITS | Class → Class | Inheritance |
| IMPLEMENTS | Class → Interface | Interface implementation |

**Knowledge Edges:**

| Predicate | From → To | Meaning |
|-----------|-----------|---------|
| HAS_CLAIM | Entity → Claim | Entity has this claim |
| SUPPORTS | Claim → Claim | Corroboration |
| CONTRADICTS | Claim → Claim | Contradiction |
| DECIDED_BY | Entity → Decision | Decision about entity |
| FULFILLS | Decision → Intent | Decision made to fulfill this objective |
| MENTIONED_IN | Entity → File/Doc | Reference |
| CHANGED_WITH | Entity → Entity | Co-change correlation |
| SAME_AS | Entity → Entity | Identity resolution |
| IN_CONFLICT | Claim → ConflictSet | Part of conflict |

### 3.4 Common Edge Fields

```
id:          UUID (deterministic from src+dst+predicate)
src:         NodeId
dst:         NodeId
predicate:   EdgePredicate enum
attrs:       JSON
provenance:  { ... }
created_rev: Long (MVCC)
deleted_rev: Long? (MVCC)
```

---

## 4. Confidence Scoring Engine

Confidence is **computed from provenance signals**, never manually assigned.

### 4.1 Formula

```
confidence(claim) = clamp(0, 1,
    base_authority(source_type)
    × verification_multiplier(claim)
    × recency_multiplier(claim, latest_rev)
    × corroboration_multiplier(claim)
    × conflict_penalty(claim)
    × intent_alignment(claim)
)
```

### 4.2 Signal Definitions

**Base Authority:**

| Source Type | Base Score | Why |
|-------------|-----------|-----|
| Passing test | 0.95 | Verified by execution |
| Code (AST-parsed) | 0.90 | The code IS the behavior |
| Config file | 0.85 | Explicitly set values |
| Human assertion | 0.85 | Developer confirmed |
| Schema/types | 0.85 | Compiler-enforced |
| Official docs | 0.75 | Human-written, intended truth |
| Commit message | 0.60 | Human intent, sometimes vague |
| PR/issue comment | 0.50 | Discussion, not assertion |
| LLM-inferred | 0.40 | Model guessed, not stated |
| Chat/Slack | 0.35 | Informal, often stale |

**Verification Multiplier:**

| State | Multiplier |
|-------|-----------|
| Test passes covering this | × 1.1 |
| Human explicitly confirmed | × 1.1 |
| Observed in running system | × 1.05 |
| No verification | × 1.0 |
| Test FAILS covering this | × 0.3 |
| Human explicitly denied | × 0.1 |

**Recency Multiplier:**

Based on **wall-clock time**, not revision distance. Revisions are for MVCC ordering;
recency is a calendar concept. Using revision distance would unfairly penalize files
ingested early in a batch (file #1 at rev 1 vs file #200 at rev 200, same moment).

| Age (wall-clock time since observation) | Multiplier |
|----------------------------------------|-----------|
| < 1 day ago | × 1.0 |
| 1-7 days ago | × 0.95 |
| 1-4 weeks ago | × 0.85 |
| 1-6 months ago | × 0.70 |
| 6+ months ago | × 0.50 |

Exception: if source file hash hasn't changed since observation, recency stays × 1.0
(the code hasn't changed, so the observation is still current regardless of age).

**Corroboration Multiplier:**

| Independent sources agreeing | Multiplier |
|-----------------------------|-----------|
| 1 source (uncorroborated) | × 1.0 |
| 2 sources agree | × 1.1 |
| 3+ sources agree | × 1.15 |

**Conflict Penalty:**

| Conflict state | Multiplier |
|---------------|-----------|
| No conflicts | × 1.0 |
| Conflict, higher authority | × 0.85 |
| Conflict, lower authority | × 0.5 |
| Resolved AGAINST this claim | × 0.1 |
| Resolved FOR this claim | × 1.1 |

**Intent Alignment:**

The design philosophy says "truth emerges as verified observations aligned with intent."
The formula must reflect this — claims connected to active intents get a small boost.

| Condition | Multiplier |
|-----------|-----------|
| Claim directly linked to active intent via FULFILLS/DECIDED_BY edges | × 1.1 |
| Claim on entity connected to active intent within 2 hops | × 1.05 |
| No connection to any intent | × 1.0 (neutral — no penalty) |
| Claim contradicts active intent | × 0.85 |

This is a small signal, not dominant. It means intent-aligned information naturally
surfaces higher without drowning out high-authority contradicting evidence.

### 4.3 Explainability

Every score includes a full breakdown:

```json
{
  "score": 0.925,
  "breakdown": {
    "baseAuthority": { "value": 0.90, "reason": "Code, AST-parsed" },
    "verification": { "value": 1.1, "reason": "Covered by passing test" },
    "recency": { "value": 1.0, "reason": "Source unchanged since observation" },
    "corroboration": { "value": 1.1, "reason": "2 independent sources agree" },
    "conflictPenalty": { "value": 0.85, "reason": "Conflict with README (lower authority)" },
    "intentAlignment": { "value": 1.05, "reason": "Entity connected to active intent within 2 hops" }
  }
}
```

---

## 5. Context Assembly Pipeline

The 8-step pipeline that turns a question into structured context.

```
Input: "How does billing retry?"

Step 1: Entity Extraction
  ├── Keyword split + normalize → ["billing", "retry"]
  ├── Synonym expansion: "retry" → ["retry", "retries", "retry_handler"]
  └── Output: search terms

Step 2: Graph Seed Lookup
  ├── Fulltext search on node names + attrs + claim statements
  │     (claim statements make search richer — "max_retries=3" is searchable)
  ├── Kind index scan for matching kinds
  ├── Phase 4 enhancement: search node descriptions (docstrings/comments
  │     stored in attrs by parser). "authentication flow" finds OAuth2Handler
  │     because its docstring says "handles OAuth 2.0 authentication flow"
  └── Output: seed node IDs

Step 3: Graph Expansion (1-2 hops, priority-weighted)
  ├── BFS from seed nodes via edges, weighted by predicate priority:
  │     Priority 1.0 (always follow): DEFINES, CONTAINS
  │     Priority 0.9: CALLS, IMPORTS
  │     Priority 0.8: DEPENDS_ON, CONFIGURES, FULFILLS
  │     Priority 0.7: HAS_CLAIM, DECIDED_BY, INHERITS, IMPLEMENTS
  │     Priority 0.4 (hop 1 only): MENTIONED_IN, CHANGED_WITH
  │     Priority 0.3 (hop 1 only): SAME_AS
  ├── High-priority edges followed at all hops, low-priority only at hop 1
  │     (prevents noise from weak connections pulling in irrelevant nodes)
  ├── MVCC filter: only visible at requested revision
  └── Output: subgraph (nodes + edges)

Step 4: Claim Collection
  ├── Gather all Claims attached to subgraph nodes
  └── Output: claim list with provenance

Step 5: Confidence Scoring
  ├── Compute confidence for each claim from provenance
  ├── Check source staleness, corroboration, conflicts
  └── Output: scored claims with breakdown

Step 6: Conflict Detection (multi-pass)
  ├── Pass 1: Exact field match — same entity, same field, different value
  │     e.g., "max_retries=3" vs "max_retries=5" → definite conflict
  ├── Pass 2: Keyword overlap — same entity, different fields, overlapping keywords
  │     e.g., "max_retries=3" vs "does not retry" → both contain "retry" → POTENTIAL conflict
  ├── Pass 3 (Phase 4): LLM-assisted — ask LLM "do these claims contradict?"
  │     The LLM judgment itself is recorded as a patch (source: LLM, 0.40)
  └── Output: conflicts list with reasoning and detection method

Step 7: Relevance Scoring
  ├── Score each claim's relevance to the original query:
  │     Claims on seed entities = 1.0 relevance
  │     Claims on 1-hop neighbors = 0.7 relevance
  │     Claims on 2-hop neighbors = 0.4 relevance
  ├── Compute final_score = relevance × confidence
  │     (trustworthy AND relevant beats trustworthy but irrelevant)
  └── Output: claims with both scores

Step 8: Ranking + Assembly
  ├── Sort claims by final_score descending
  ├── Group by entity for structure
  └── Output: StructuredContext
```

### StructuredContext (output format)

```json
{
  "claims": [{
    "statement": "retry_payment has max_retries=3",
    "confidence": { "score": 0.90, "breakdown": { ... } },
    "provenance": {
      "sourceUri": "billing_service.py",
      "sourceHash": "abc123",
      "extractor": "tree-sitter-python",
      "sourceType": "Code",
      "observedRev": 1
    },
    "entityId": "uuid-of-retry-payment"
  }],
  "conflicts": [{
    "claimA": { "statement": "max_retries=3", "confidence": 0.90 },
    "claimB": { "statement": "does not retry", "confidence": 0.64 },
    "reason": "Contradictory statements about retry behavior",
    "recommendation": "Trust code (0.90) over docs (0.64)"
  }],
  "decisions": [{
    "title": "Use exponential backoff",
    "rationale": "Linear caused cascading failures",
    "entity": "BillingService",
    "intentId": "uuid-of-intent",
    "rev": 25
  }],
  "intents": [{
    "statement": "Handle transient failures",
    "status": "ACTIVE",
    "confidence": 0.85,
    "parentIntent": "Build a scalable billing service"
  }],
  "nodes": [ ... ],
  "edges": [ ... ],
  "metadata": {
    "query": "How does billing retry?",
    "seedEntities": ["BillingService", "retry_payment"],
    "hopsExpanded": 2,
    "asOfRev": 48,
    "depth": "standard",
    "conflicts": 1,
    "claimsReturned": 5
  }
}
```

---

## 6. Ingestion Pipeline

### 6.1 Parser Routing

| Source | Parser | Deterministic? | Authority |
|--------|--------|---------------|-----------|
| Python (.py) | tree-sitter AST | Yes | Code (0.90) |
| TypeScript (.ts/.tsx) | tree-sitter AST | Yes | Code (0.90) |
| Config (.yaml/.json/.toml) | Schema parser | Yes | Config (0.85) |
| Markdown (.md) | Section parser | Yes | Doc (0.75) |
| Unstructured text | LLM extraction | No | LLM (0.40) |

### 6.2 Ingestion Flow

```
Source file → discover files → route to parser by extension
  ↓
Parser extracts entities + relationships → ParseResult { entities, relationships }
  ↓
GraphPatchBuilder → builds patch with deterministic node IDs + full provenance
  ↓
PatchValidator → checks schema, referential integrity
  ↓
GraphWriteApi.commitPatch() → atomic commit with MVCC revision tracking
  ↓
CommitResult { newRev, status, nodesCreated, edgesCreated }
```

### 6.3 What the Parser Extracts (Python example)

```python
# billing_service.py
from payment_gateway import PaymentGateway

class BillingService:
    def retry_payment(self, amount, max_retries=3):
        for i in range(max_retries):
            result = PaymentGateway.charge(amount)
            if result.success:
                return result
        raise PaymentError("Max retries exceeded")
```

Produces:
```
Nodes:
  File("billing_service.py", lang=python, hash=abc123)
  Class("BillingService", lines=3-10)
  Function("retry_payment", sig="(self, amount, max_retries=3)", lines=4-9)

Edges:
  File → BillingService (DEFINES)
  BillingService → retry_payment (DEFINES)
  billing_service.py → payment_gateway (IMPORTS)
  retry_payment → PaymentGateway.charge (CALLS)

Claims (auto-generated by parser — this is critical for confidence/conflict to work):
  AssertClaim(BillingService, "defines_method", "retry_payment")
  AssertClaim(retry_payment, "parameter_default:max_retries", "3")
  AssertClaim(retry_payment, "calls", "PaymentGateway.charge")
  AssertClaim(retry_payment, "raises", "PaymentError")
  → All get source type Code (base authority 0.90)
  → Without parser-generated claims, the confidence scoring engine
    and conflict detector have nothing to operate on

Patch:
  actor: "tree-sitter-python/1.0"
  source: { uri: "billing_service.py", hash: "abc123", sourceType: Code }
  intent: "Parsed billing_service.py"
```

### 6.4 Why Parsers Must Generate Claims

Nodes and edges give you **structure** (what exists, how things connect).
Claims give you **assertable facts** that can be scored, contradicted, and traced.

Without parser-generated claims:
- Confidence scoring has nothing to score (it scores claims, not nodes)
- Conflict detection has nothing to compare (it compares claims on the same entity)
- A README saying "does not retry" has no code-sourced claim to contradict

**Rule:** Every parser MUST generate claims alongside nodes and edges. Claims are
what make the confidence/conflict/provenance system work on parsed data, not just
on manual assertions.

| Parser output | What it feeds |
|---------------|---------------|
| Nodes | Graph structure (existence) |
| Edges | Graph structure (relationships) |
| Claims | Confidence engine, conflict detector, provenance chain |

---

## 7. CLI

### 7.1 Command Reference

```
ix — Persistent Memory for LLM Systems

SETUP:
  ix init                            Initialize Ix in current project
                                     (starts Docker, creates config, writes CLAUDE.md)
  ix mcp install                     Configure Claude Desktop MCP
  ix mcp install --cursor            Configure Cursor MCP

AUTHENTICATION:
  ix login                           Authenticate (stores token in ~/.ix/credentials)
  ix signup                          Create account
  ix whoami                          Show current user
  ix logout                          Clear credentials

INGESTION:
  ix ingest <path>                   Ingest source files into the graph
    --language <lang>                  Force language (auto-detected)
    --recursive                        Walk directory tree
    --watch                            Watch + auto-re-ingest on changes

QUERYING:
  ix query "<question>"              Query graph → structured context
    --as-of <rev>                      Time-travel query
    --format json|text|markdown        Output format
    --hops <n>                         Expansion depth (default: 2)
  ix entity <id>                     Inspect single entity
  ix search <term>                   Search nodes by name/kind
  ix expand <id>                     Show entity neighborhood
    --direction in|out|both
    --hops <n>

INTENT (user truth/objectives — the hierarchy anchor):
  ix truth set "<statement>"           Set the root intent/objective
  ix truth add "<sub-intent>"          Add a sub-intent under the root
    --parent <intent-id>                 Nest under specific parent intent
  ix truth update "<new-statement>"    Update an intent (creates new rev)
    --id <intent-id>                     Which intent to update
  ix truth list                        Show current intent hierarchy
    --as-of <rev>                        Time-travel: intents at revision
  ix truth approve <intent-id>         Confirm an LLM-proposed sub-intent
                                         (raises confidence from 0.40 to 0.85)
  ix truth abandon <intent-id>         Mark intent as abandoned (with reason)

TRUTH & DECISIONS:
  ix assert <entity-id> "<statement>"  Manually assert a fact
    --source "<reason>"                  Why (confidence is ALWAYS computed from
                                           provenance — human assertion = 0.85 base)
  ix retract <claim-id> "<reason>"     Retract a claim
  ix decide "<title>"                  Record a decision
    --rationale "<text>"                 Why chosen
    --alternatives "<a>, <b>"            What was considered
    --entity <id>                        Link to entity
  ix resolve <conflict-id>             Resolve a conflict
    --winner <claim-id>

HISTORY & DIFF:
  ix diff <revA> <revB>             What changed between revisions
    --entity <id>                      Scope to entity
  ix history <entity-id>            Full provenance chain
  ix conflicts                       List conflicts
    --status open|resolved|all

PATCHES (time navigation):
  ix patches                         List recent patches (moments in time)
    --source <uri>                     Filter by source file
    --actor <name>                     Filter by who created them
    --since <rev>                      Since revision
    --limit <n>                        Max results (default: 20)
  ix patch <patch-id>                Inspect a specific patch
                                       Shows: ops, source, actor, timestamp,
                                       what it replaced, what replaced it

STATUS:
  ix status                          Graph stats: nodes, edges, rev, conflicts
  ix config set <key> <value>        Set config
  ix config show                     Show config (~/.ix/config.yaml)
```

### 7.2 CLI Design Principles

- **Looks like Claude Code CLI** — similar structure, output formatting, feel
- **Every command is a thin HTTP call** — no business logic in the CLI
- **Terminal formatting** — tables, colors, tree views for entity inspection
- **JSON output option** — every command supports `--format json` for scripting
- **Config in ~/.ix/config.yaml** — endpoint, format defaults

---

## 8. MCP Server

### 8.1 MCP Tools

The LLM sees these tools:

```json
[
  {
    "name": "ix_query",
    "description": "ALWAYS call this before answering questions about the codebase. Returns structured context with confidence-scored claims, conflicts, and provenance. Your training data may be stale — this tool has current observations backed by evidence. Start with 'summary' depth and drill down with ix_expand/ix_entity if needed.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "question": { "type": "string", "description": "The question to answer" },
        "asOfRev": { "type": "number", "description": "Optional: query at specific revision for time-travel" },
        "depth": { "type": "string", "enum": ["summary", "standard", "full"], "description": "Response detail level. summary (~200 tokens): top 5 claims + conflict/decision counts. standard (~500-1000 tokens, default): claims + conflicts + decisions + seed nodes. full (~2000+ tokens): everything including all nodes, edges, full provenance breakdowns. Start with summary or standard, drill down with ix_expand/ix_entity." }
      },
      "required": ["question"]
    }
  },
  {
    "name": "ix_decide",
    "description": "Call this AFTER making any design or architecture decision. Records the decision with rationale so future sessions can trace why things were built this way. Creates a Decision node linked to the relevant entity (DECIDED_BY edge) and intent (FULFILLS edge).",
    "inputSchema": {
      "type": "object",
      "properties": {
        "title": { "type": "string", "description": "Brief title of the decision" },
        "rationale": { "type": "string", "description": "Why this was chosen" },
        "alternatives": { "type": "array", "items": { "type": "string" }, "description": "What other options were considered" },
        "entityId": { "type": "string", "description": "Optional: entity this decision relates to (creates DECIDED_BY edge)" },
        "intentId": { "type": "string", "description": "Optional: intent this decision fulfills (creates FULFILLS edge). Enables tracing: Intent → FULFILLS → Decision → DECIDED_BY → Entity" }
      },
      "required": ["title", "rationale"]
    }
  },
  {
    "name": "ix_ingest",
    "description": "Call this after modifying code files. Re-ingests the file to update the memory graph with current state.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": { "type": "string", "description": "File or directory path to ingest" },
        "recursive": { "type": "boolean", "description": "Walk directory tree" }
      },
      "required": ["path"]
    }
  },
  {
    "name": "ix_entity",
    "description": "Inspect a specific entity: its attributes, claims, edges, and provenance chain.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "id": { "type": "string", "description": "Entity UUID" },
        "asOfRev": { "type": "number", "description": "Optional: inspect at specific revision" }
      },
      "required": ["id"]
    }
  },
  {
    "name": "ix_search",
    "description": "Search for entities by name or kind. Use when you need to find specific nodes in the graph.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "term": { "type": "string", "description": "Search term (name, keyword)" },
        "kind": { "type": "string", "description": "Optional: filter by node kind (Class, Function, etc.)" }
      },
      "required": ["term"]
    }
  },
  {
    "name": "ix_assert",
    "description": "Manually assert a fact about an entity. Use when you have information not captured by automatic parsing.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "entityId": { "type": "string", "description": "Entity to assert about" },
        "statement": { "type": "string", "description": "The fact being asserted" },
        "source": { "type": "string", "description": "Why you're asserting this" }
      },
      "required": ["entityId", "statement"]
    }
  },
  {
    "name": "ix_diff",
    "description": "Show what changed between two revisions. Use for 'what changed since last session?' queries.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "revA": { "type": "number", "description": "Start revision" },
        "revB": { "type": "number", "description": "End revision (default: latest)" },
        "entityId": { "type": "string", "description": "Optional: scope to entity" }
      },
      "required": ["revA"]
    }
  },
  {
    "name": "ix_conflicts",
    "description": "Check for contradictory claims. Call when you notice conflicting information or want to verify consistency.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "status": { "type": "string", "enum": ["open", "resolved", "all"], "description": "Filter by status" }
      }
    }
  },
  {
    "name": "ix_resolve",
    "description": "Resolve a conflict by choosing the correct claim. Use after investigating contradictory information.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "conflictId": { "type": "string", "description": "Conflict to resolve" },
        "winnerClaimId": { "type": "string", "description": "The claim that is correct" }
      },
      "required": ["conflictId", "winnerClaimId"]
    }
  },
  {
    "name": "ix_expand",
    "description": "Explore the neighborhood of an entity — what it connects to via edges.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "entityId": { "type": "string", "description": "Entity to expand from" },
        "direction": { "type": "string", "enum": ["in", "out", "both"], "description": "Edge direction" },
        "hops": { "type": "number", "description": "Number of hops (default: 1)" }
      },
      "required": ["entityId"]
    }
  },
  {
    "name": "ix_history",
    "description": "Trace the full provenance chain of an entity — every patch that touched it, when, by whom, and why.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "entityId": { "type": "string", "description": "Entity to trace" }
      },
      "required": ["entityId"]
    }
  },
  {
    "name": "ix_truth",
    "description": "View or manage the project's intent hierarchy (user-defined objectives). Call this to understand WHAT the project is trying to accomplish. When the user states a new goal or sub-goal, call this to record it. When you want to propose a sub-intent based on your analysis, call this with proposed=true.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["list", "set", "add", "update", "approve", "abandon"], "description": "What to do" },
        "statement": { "type": "string", "description": "The intent statement (for set/add/update)" },
        "intentId": { "type": "string", "description": "Target intent ID (for update/approve/abandon)" },
        "parentId": { "type": "string", "description": "Parent intent ID (for add, to create sub-intent)" },
        "proposed": { "type": "boolean", "description": "True if this is an LLM-proposed sub-intent (lower confidence until user approves)" }
      },
      "required": ["action"]
    }
  },
  {
    "name": "ix_patches",
    "description": "Search and inspect patches — moments in time. Each patch records what was observed, by whom, when, and what it replaced. Use to understand change history, navigate to any point in time, or trace how the graph evolved. Use ix_query with asOfRev to see the graph state at a specific patch's revision.",
    "inputSchema": {
      "type": "object",
      "properties": {
        "action": { "type": "string", "enum": ["list", "get"], "description": "list = search patches, get = inspect one patch" },
        "patchId": { "type": "string", "description": "Patch ID to inspect (for get)" },
        "source": { "type": "string", "description": "Filter by source URI (for list)" },
        "actor": { "type": "string", "description": "Filter by actor (for list)" },
        "sinceRev": { "type": "number", "description": "Only patches after this revision (for list)" },
        "limit": { "type": "number", "description": "Max results, default 20 (for list)" }
      },
      "required": ["action"]
    }
  }
]
```

### 8.2 MCP Resources (Minimal — Context Is Traversed, Not Pre-Loaded)

**Design principle:** The whole point of Ix is that context is retrieved by traversing the graph, not pre-loaded into the context window. Auto-injected resources should be a **minimal nudge** (~30-40 tokens total) reminding the LLM that Ix exists and to use it. The LLM gets full data by calling tools (`ix_query`, `ix_conflicts`, `ix_truth`, `ix_patches`, etc.).

```
ix://session/context
  → Minimal status line. Just enough to remind the LLM Ix is active.
  → "Ix Memory active. Rev 48. 156 nodes. ALWAYS call ix_query before answering."
  → ~20 tokens

ix://project/intent
  → Root intent only (one line). LLM calls ix_truth for full hierarchy.
  → "Intent: Build a scalable billing service"
  → ~10 tokens
```

**Why only 2 resources, not 4:**
- ~~`ix://session/conflicts`~~ — Removed. LLM calls `ix_conflicts` when it needs conflict info. Pre-loading conflicts wastes context on things that may not be relevant to the current question.
- ~~`ix://session/recent`~~ — Removed. LLM calls `ix_diff` or `ix_patches` when it needs change history. Pre-loading recent changes is a data dump, not traversal.

**The context window is for work, not data.** Ix's value is that the LLM queries for exactly what it needs, when it needs it. Every token of pre-loaded context is a token the LLM can't use for reasoning.

### 8.3 MCP Server Instructions

The MCP protocol allows server-provided instructions:

```json
{
  "instructions": "You have access to Ix Memory — a persistent, time-aware memory system for this codebase. RULES: (1) ALWAYS call ix_query before answering questions about the codebase. Your training data may be outdated; Ix has current, provenance-backed observations. (2) AFTER any design or architecture decision, call ix_decide to record it with rationale. (3) When you notice conflicting information, call ix_conflicts to check for known contradictions. (4) NEVER answer from memory alone when Ix has structured data available. (5) After modifying code, call ix_ingest on changed files to keep the graph current."
}
```

---

## 9. Enforcement Architecture

### 9.1 Five Enforcement Layers

| Layer | Mechanism | Strength | Bypassable? |
|-------|-----------|----------|-------------|
| 1. MCP Server instructions | Protocol-level rules the LLM sees at start | **Strongest** | Technically yes, unlikely |
| 2. CLAUDE.md | Project-level mandatory rules | **Strongest** | Only if LLM ignores rules |
| 3. Tool descriptions | Per-tool "ALWAYS call" prompts | Strong | Yes — might not call tool |
| 4. MCP Resources | Minimal nudge (~30 tokens, reminds LLM Ix exists) | Medium | No — already in context |
| 5. Session tracking | Server-side working set tracking | Medium | No — server-side logic |

**Key insight:** Enforcement comes from rules and tool descriptions telling the LLM WHEN to query. Not from pre-loading data. The LLM traverses the graph for context — that's the whole point of Ix.

### 9.2 Configuration Files

**claude_desktop_config.json** (for Claude Desktop):
```json
{
  "mcpServers": {
    "ix-memory": {
      "command": "ix",
      "args": ["mcp", "start"],
      "env": {
        "IX_ENDPOINT": "http://localhost:8090",
        "IX_PROJECT": "my-project"
      }
    }
  }
}
```

**CLAUDE.md** (for Claude Code, auto-generated by `ix init`):
```markdown
# Ix Memory System

This project uses Ix Memory for persistent, time-aware context.

## MANDATORY RULES
1. BEFORE answering any question about this codebase → call ix_query
2. AFTER making any design/architecture decision → call ix_decide
3. When noticing contradictory information → call ix_conflicts
4. NEVER guess about codebase facts when Ix has structured data
5. After modifying code → call ix_ingest on changed files
6. At start of each session → review ix://session/context for prior work
```

### 9.3 How Enforcement Works in Practice

```
Turn 1: User asks "How does billing retry?"

  1. MCP Resource ix://session/context auto-injects (~20 tokens):
     "Ix Memory active. Rev 48. 156 nodes. ALWAYS call ix_query before answering."

  2. CLAUDE.md says: "BEFORE answering → call ix_query"

  3. Tool ix_query description says: "ALWAYS call this first"

  4. LLM calls ix_query("How does billing retry?")
     → Traverses graph → Gets StructuredContext with claims, confidence, provenance

  5. LLM responds WITH provenance:
     "Based on billing_service.py (confidence 0.90, rev 1):
      retry_payment uses max_retries=3..."

Turn 2: User asks "Should we use circuit breaker instead?"

  1. MCP Resource still just the nudge:
     "Ix Memory active. Rev 48. 156 nodes. ALWAYS call ix_query before answering."

  2. LLM calls ix_query("circuit breaker vs exponential backoff")
     → Traverses graph for relevant context

  3. LLM discusses options, then decides:
     "I recommend keeping exponential backoff over circuit breaker."

  4. CLAUDE.md says: "AFTER design decision → call ix_decide"

  5. LLM calls ix_decide({
       title: "Keep exponential backoff over circuit breaker",
       rationale: "Circuit breaker adds complexity, exponential backoff
                   already handles transient failures well",
       alternatives: ["circuit breaker", "linear backoff", "no retry"]
     })

  6. Decision recorded in graph as a patch with full provenance.
```

---

## 10. Packaging & Distribution

### 10.1 Repository Structure

```
IX-Memory-Repo/
├── stack.sh                        # Start/stop backend containers
├── dev.sh                          # Local dev mode
├── docker-compose.yml              # Backend: ArangoDB + Memory Layer
│
├── memory-layer/                   # Scala — core engine (Docker)
│   ├── build.sbt
│   ├── Dockerfile
│   ├── dist/                       # Pre-built ix-memory.jar
│   └── src/main/scala/ix/memory/
│       ├── Main.scala
│       ├── api/                    # HTTP routes
│       ├── context/                # Query pipeline
│       ├── ingestion/              # Parsers
│       ├── model/                  # Data types
│       ├── db/                     # ArangoDB
│       └── conflict/               # Conflict service
│
├── ix-cli/                         # TypeScript — CLI + MCP (npm)
│   ├── package.json                # @ix/cli
│   ├── tsconfig.json
│   ├── src/
│   │   ├── cli/                    # Commands (commander.js)
│   │   ├── mcp/                    # MCP server
│   │   │   ├── server.ts           # stdio handler
│   │   │   ├── tools/              # Tool definitions
│   │   │   ├── resources/          # Resource providers
│   │   │   └── session.ts          # Session state
│   │   └── client/                 # HTTP client
│   └── test/
│
├── templates/                      # Config templates for ix init
│   ├── CLAUDE.md.template
│   └── claude_desktop_config.json.template
│
└── docs/plans/                     # Design documents
```

### 10.2 Docker Architecture

```yaml
# docker-compose.yml
services:
  arangodb:
    image: arangodb:3.12
    ports: ["8529:8529"]
    volumes: [ix_arango_data:/var/lib/arangodb3]
    healthcheck: curl -sf http://localhost:8529/_api/version

  memory-layer:
    image: ix/memory-layer:local
    depends_on: { arangodb: { condition: service_healthy } }
    ports: ["8090:8090"]
    environment:
      ARANGO_HOST: arangodb
      ARANGO_PORT: "8529"
      ARANGO_DATABASE: ix_memory
    healthcheck: curl -sf http://localhost:8090/v1/health
```

### 10.3 First-Run Experience

```bash
# Install CLI
npm install -g @ix/cli

# Initialize in project
cd ~/my-project
ix init
# → Starts Docker containers
# → Creates ~/.ix/config.yaml
# → Creates ./CLAUDE.md
# → Optionally configures Claude Desktop
# → Optionally ingests project

# Use
ix ingest ./src --recursive
ix query "How does billing retry?"
ix status
```

### 10.4 stack.sh

Single script to manage backend:
```bash
./stack.sh          # Build + start (ArangoDB + Memory Layer)
./stack.sh down     # Stop everything
./stack.sh logs     # View logs
```

---

## 11. User Guide: Starting the Stack

> Lives at: `docs/guides/user-guide.md` (full version) + summarized in `README.md`

### 11.1 Prerequisites

```
- Docker Desktop (or Docker Engine + Docker Compose)
- Node.js 18+ (for the CLI)
- npm (comes with Node.js)
```

### 11.2 Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/ix-infrastructure/IX-Memory-Repo.git
cd IX-Memory-Repo

# 2. Start the backend (ArangoDB + Memory Layer)
./stack.sh

#   What this does:
#   ┌──────────────────────────────────────────────────────────┐
#   │  stack.sh                                                 │
#   │  1. Checks Docker is installed and running               │
#   │  2. Builds Memory Layer JAR (if not pre-built)           │
#   │  3. Builds Docker image: ix/memory-layer:local           │
#   │  4. Runs: docker compose up -d                           │
#   │     ├── arangodb:3.12  → port 8529 (graph database)     │
#   │     └── memory-layer   → port 8090 (API server)         │
#   │  5. Waits for health check to pass                       │
#   │  6. Prints: "Ix Memory backend is ready"                 │
#   └──────────────────────────────────────────────────────────┘

# 3. Install the CLI
npm install -g @ix/cli

# 4. Initialize Ix in your project
cd ~/your-project
ix init

#   What this does:
#   ┌──────────────────────────────────────────────────────────┐
#   │  ix init                                                  │
#   │  1. Verifies backend is running (http://localhost:8090)  │
#   │  2. Creates ~/.ix/config.yaml (endpoint, defaults)       │
#   │  3. Creates ./CLAUDE.md (enforcement rules for LLM)      │
#   │  4. Asks: "Configure Claude Desktop?" → updates config   │
#   │  5. Asks: "Ingest this project?" → parses codebase       │
#   └──────────────────────────────────────────────────────────┘

# 5. Ingest your codebase
ix ingest ./src --recursive

# 6. Query
ix query "How does billing handle retries?"

# 7. Check status
ix status
```

### 11.3 Managing the Stack

```bash
./stack.sh          # Start backend (build if needed)
./stack.sh down     # Stop all containers
./stack.sh logs     # Tail container logs

# Check container health
docker compose ps

# Reset database (delete all data)
docker compose down -v    # -v removes volumes
./stack.sh                # Fresh start
```

### 11.4 Development Mode

For working on the Memory Layer itself (no Docker for the Scala service):

```bash
./dev.sh            # Starts ArangoDB in Docker, runs Memory Layer via sbt
./dev.sh stop       # Stops ArangoDB container
```

---

## 12. LLM Integration Guide: Connecting Ix to Your LLM

> Lives at: `docs/guides/llm-integration.md` (full version) + summarized in `README.md`

### 12.1 Overview

Ix integrates with LLMs through two mechanisms:
1. **MCP Server** — provides tools and auto-injected context to the LLM
2. **System prompts** (CLAUDE.md) — rules that tell the LLM to use Ix

```
Your LLM (Claude Desktop, Claude Code, Cursor)
  │
  ├── Reads CLAUDE.md → learns the rules ("always call ix_query first")
  ├── Connects to MCP Server → gets tools (ix_query, ix_decide, etc.)
  └── Receives MCP Resources → auto-injected context every turn
```

### 12.2 Claude Desktop Integration

**Step 1:** Run `ix mcp install` (or do it manually):

```json
// ~/Library/Application Support/Claude/claude_desktop_config.json (macOS)
// %APPDATA%/Claude/claude_desktop_config.json (Windows)
{
  "mcpServers": {
    "ix-memory": {
      "command": "ix",
      "args": ["mcp", "start"],
      "env": {
        "IX_ENDPOINT": "http://localhost:8090",
        "IX_PROJECT": "my-project"
      }
    }
  }
}
```

**Step 2:** Restart Claude Desktop. You should see "ix-memory" in the MCP tools list.

**Step 3:** Open a conversation. The LLM now has access to:

| What | How | Enforcement |
|------|-----|-------------|
| **13 tools** (ix_query, ix_decide, ix_ingest, ix_patches, etc.) | LLM calls them like functions | Tool descriptions say WHEN to call |
| **2 resources** (session status + root intent, ~30 tokens) | Minimal nudge every turn | Passive — reminds LLM to use Ix |
| **Server instructions** | Sent via MCP protocol | Rules the LLM sees at start |

### 12.3 Claude Code Integration

**Step 1:** Add CLAUDE.md to your project root (auto-generated by `ix init`):

```markdown
# Ix Memory System

This project uses Ix Memory for persistent, time-aware context.

## MANDATORY RULES
1. BEFORE answering any question about this codebase → call ix_query
2. AFTER making any design/architecture decision → call ix_decide
3. When noticing contradictory information → call ix_conflicts
4. NEVER guess about codebase facts when Ix has structured data
5. After modifying code → call ix_ingest on changed files
6. At start of each session → review ix://session/context for prior work
7. When the user states a goal → call ix_truth to record it
```

**Step 2:** Add MCP server to Claude Code settings (`.claude/settings.json` or via `ix mcp install --claude-code`):

```json
{
  "mcpServers": {
    "ix-memory": {
      "command": "ix",
      "args": ["mcp", "start"],
      "env": {
        "IX_ENDPOINT": "http://localhost:8090"
      }
    }
  }
}
```

**Step 3:** Start Claude Code in your project directory. Both CLAUDE.md rules and MCP tools are active.

### 12.4 Cursor Integration

```bash
ix mcp install --cursor
```

This writes to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "ix-memory": {
      "command": "ix",
      "args": ["mcp", "start"],
      "env": {
        "IX_ENDPOINT": "http://localhost:8090"
      }
    }
  }
}
```

### 12.5 How Enforcement Works (What the LLM Sees)

On every conversation turn, the LLM receives:

**1. Auto-injected resources (minimal nudge, ~30 tokens — NOT a data dump):**

```
[ix://session/context]
Ix Memory active. Rev 48. 156 nodes. ALWAYS call ix_query before answering.

[ix://project/intent]
Intent: Build a scalable billing service
```

Context is traversed, not pre-loaded. The LLM calls tools to get the data it needs.

**2. Available tools with enforcement descriptions (13 tools):**

```
ix_query: "ALWAYS call this before answering questions about the codebase..."
ix_decide: "Call this AFTER making any design or architecture decision..."
ix_ingest: "Call this after modifying code files..."
ix_truth: "View or manage the project's intent hierarchy..."
ix_patches: "Search and inspect patches — moments in time..."
ix_conflicts: "Check for contradictory claims..."
```

**3. CLAUDE.md rules (Claude Code only):**

```
MANDATORY: BEFORE answering → call ix_query
MANDATORY: AFTER decisions → call ix_decide
```

### 12.6 Verification: Is It Working?

After setup, test the integration:

```bash
# 1. Make sure backend is running
ix status
# Should show: "Connected to http://localhost:8090, rev: N, X nodes, Y edges"

# 2. In your LLM, ask a question about your codebase
# "How does billing handle retries?"

# 3. The LLM should:
#    a. Call ix_query (you'll see the tool call in the UI)
#    b. Respond with provenance: "Based on billing_service.py (confidence 0.90)..."
#    c. Mention conflicts if any exist

# 4. Check what the LLM recorded
ix history <entity-id>
# Should show patches from both ingestion AND LLM decisions
```

### 12.7 Troubleshooting

| Problem | Solution |
|---------|----------|
| LLM doesn't call ix_query | Check CLAUDE.md exists in project root. Check MCP server is listed in config. |
| "Connection refused" | Run `./stack.sh` to start backend. Check `ix status`. |
| MCP tools not showing | Restart Claude Desktop/Cursor after config change. |
| Stale data | Run `ix ingest ./src --recursive` to refresh. |
| LLM ignores memory | Strengthen CLAUDE.md rules. Check MCP server instructions field. |

---

## 13. Documentation Structure

```
IX-Memory-Repo/
├── README.md                              # Quick-start summary with links
│   ├── What is Ix?  (2 sentences)
│   ├── Quick Start  (5 commands)
│   ├── Link → docs/guides/user-guide.md
│   └── Link → docs/guides/llm-integration.md
│
├── docs/
│   ├── guides/
│   │   ├── user-guide.md                  # Full: stack.sh, CLI, commands
│   │   └── llm-integration.md             # Full: MCP, CLAUDE.md, enforcement
│   └── plans/
│       ├── 2026-03-03-ix-redesign.md      # This design document
│       └── (implementation plan)
```

---

## 14. Build Phases (Redesign)

### Phase 1: Adapt Memory Layer (Scala) — EXISTING, needs updates

The existing Phase 1 code is mostly reusable. Updates needed:
- **Remove TenantId** from all models, APIs, and DB queries (single-codebase system)
- Add Decision node type + DECIDED_BY edge to model
- Add `/v1/decide` endpoint
- Add `/v1/search` endpoint
- Update StructuredContext to include decisions
- Update deterministic ID generation to remove tenant prefix
- Ensure all existing E2E tests still pass (updated for no-tenant)

### Phase 2: CLI + MCP Server (TypeScript) — NEW

Build the TypeScript package:
- CLI commands (commander.js, all calling Memory Layer HTTP API)
- MCP server (stdio, @modelcontextprotocol/sdk)
- MCP Resources (session context, conflicts, recent changes)
- Session manager (track working set)
- `ix init` command (Docker setup, config generation, CLAUDE.md)
- `ix mcp install` command (configure Claude Desktop/Cursor)

### Phase 3: Enforcement & Polish

- CLAUDE.md template with optimal enforcement rules
- Tool descriptions optimized for maximum LLM compliance
- MCP server instructions field
- Session restoration across conversations
- Terminal UI polish (tables, colors, tree views)

### Phase 4: Additional Parsers + Advanced Features

- TypeScript parser (tree-sitter)
- Config parser (YAML/JSON/TOML)
- Markdown parser
- Corroboration counting across sources
- Staleness detection (source hash changed)
- Working set continuity
- Metrics: comparing old system vs new (accuracy measurement)

---

## 15. Key Design Decisions (Rationale)

| Decision | Chosen | Alternatives Considered | Why |
|----------|--------|------------------------|-----|
| MCP enforcement model | MCP-Heavy (Resources + instructions + tool descriptions) | Stateless proxy, Dual-layer | Maximum enforcement. Resources = passive injection = closest to 100% |
| CLI/MCP language | TypeScript | Rust, Go, Kotlin, Scala | Official MCP SDK is TypeScript. Largest contributor pool. npm distribution standard. |
| Memory Layer language | Scala (keep existing) | Rewrite in Rust/Go | Already built, 48 files, full test suite. Cats Effect is production-grade. No reason to rewrite. |
| Backend packaging | Docker Compose | Kubernetes, bare metal | Matches SimplestData. Simple for dev/demo. K8s later for prod. |
| CLI/MCP packaging | npm (local install) | Docker, Homebrew | MCP needs stdio (local). CLI needs file access (local). npm is standard. |
| No multi-tenancy | Single codebase system | Per-org/per-user isolation | System serves one codebase. Everyone sees same graph. Simpler model, no TenantId on every entity. |
| DB | ArangoDB now, custom later | Neo4j, SurrealDB, Memgraph | Already integrated. Trait-based API allows swap. Custom DB is long-term goal. |
| Node IDs | Deterministic (UUID.nameUUIDFromBytes) | Random UUID, sequential | Enables idempotent re-ingestion. Same file → same nodes. Deterministic graph from same patch log. |
| Confidence | Computed from provenance, never manual | Manual scores, fixed weights | Eliminates subjectivity. Explainable breakdowns. Changes automatically as evidence accumulates. |
| Conflicts | Surfaced to user, not auto-resolved | Auto-pick winner, ignore | "Conflict is a feature, not a bug." Human judgment for resolution. Transparency. |
