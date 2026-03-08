# GitHub Ingestion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Ingest GitHub issues, PRs, and commits into the Ix knowledge graph via `ix ingest --github owner/repo`.

**Architecture:** The CLI fetches data from GitHub's REST API, builds GraphPatch operations (UpsertNode, UpsertEdge, AssertClaim), and submits them to a new `POST /v1/patch` backend endpoint. The backend commits patches using existing infrastructure. Auth resolves via `gh auth token` → `GITHUB_TOKEN` env → `--token` flag.

**Tech Stack:** TypeScript CLI (commander, node fetch), Scala backend (http4s, circe), GitHub REST API

---

### Task 1: Add `POST /v1/patch` Backend Endpoint

**Files:**
- Create: `memory-layer/src/main/scala/ix/memory/api/PatchCommitRoutes.scala`
- Modify: `memory-layer/src/main/scala/ix/memory/api/Routes.scala:28-50`

**Step 1: Write the PatchCommitRoutes class**

Create `memory-layer/src/main/scala/ix/memory/api/PatchCommitRoutes.scala`:

```scala
package ix.memory.api

import cats.effect.IO
import io.circe.syntax._
import io.circe.Json
import org.http4s.HttpRoutes
import org.http4s.circe.CirceEntityCodec._
import org.http4s.dsl.io._

import ix.memory.db.GraphWriteApi
import ix.memory.model.GraphPatch

class PatchCommitRoutes(writeApi: GraphWriteApi) {

  val routes: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case req @ POST -> Root / "v1" / "patch" =>
      (for {
        patch  <- req.as[GraphPatch]
        result <- writeApi.commitPatch(patch)
        resp   <- Ok(Json.obj(
          "status" -> result.status.toString.asJson,
          "rev"    -> result.newRev.value.asJson
        ))
      } yield resp).handleErrorWith(ErrorHandler.handle(_))
  }
}
```

**Step 2: Wire into Routes.scala**

In `memory-layer/src/main/scala/ix/memory/api/Routes.scala`, add after line 42 (`val statsRoutes`):

```scala
val patchCommitRoutes = new PatchCommitRoutes(writeApi).routes
```

And add `<+> patchCommitRoutes` to the route chain on line 45.

**Step 3: Build backend**

Run: `cd memory-layer && sbt compile`
Expected: Compiles successfully

**Step 4: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/api/PatchCommitRoutes.scala \
        memory-layer/src/main/scala/ix/memory/api/Routes.scala
git commit -m "feat: add POST /v1/patch endpoint for direct patch submission"
```

---

### Task 2: Add `commitPatch` to CLI Client

**Files:**
- Modify: `ix-cli/src/client/api.ts:1-173`
- Modify: `ix-cli/src/client/types.ts:1-153`

**Step 1: Add PatchOp and GraphPatch types to types.ts**

Add at the end of `ix-cli/src/client/types.ts`:

```typescript
export interface PatchSource {
  uri: string;
  sourceHash?: string;
  extractor: string;
  sourceType: string; // "code" | "config" | "doc" | "commit" | "comment" | "human"
}

export interface PatchOp {
  type: string;
  [key: string]: unknown;
}

export interface GraphPatchPayload {
  patchId: string;
  actor: string;
  timestamp: string;
  source: PatchSource;
  baseRev: number;
  ops: PatchOp[];
  replaces: string[];
  intent?: string;
}

export interface PatchCommitResult {
  status: string;
  rev: number;
}
```

**Step 2: Add commitPatch method to IxClient**

Add to `ix-cli/src/client/api.ts` after the `provenance` method (around line 142):

```typescript
async commitPatch(patch: GraphPatchPayload): Promise<PatchCommitResult> {
  return this.post("/v1/patch", patch);
}
```

Add `GraphPatchPayload, PatchCommitResult` to the imports from `./types.js` at line 1.

**Step 3: Build CLI**

Run: `cd ix-cli && npm run build`
Expected: Compiles successfully

**Step 4: Commit**

```bash
git add ix-cli/src/client/api.ts ix-cli/src/client/types.ts
git commit -m "feat: add commitPatch client method and GraphPatch types"
```

---

### Task 3: Add GitHub Auth Helper

**Files:**
- Create: `ix-cli/src/cli/github/auth.ts`
- Test: `ix-cli/src/cli/__tests__/github-auth.test.ts`

**Step 1: Write the failing test**

Create `ix-cli/src/cli/__tests__/github-auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We'll test the resolution logic without actually calling gh
describe("GitHub auth resolution", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses --token flag when provided", async () => {
    const { resolveGitHubToken } = await import("../github/auth.js");
    const token = await resolveGitHubToken("my-pat-token");
    expect(token).toBe("my-pat-token");
  });

  it("uses GITHUB_TOKEN env when no --token", async () => {
    process.env.GITHUB_TOKEN = "env-token-123";
    const { resolveGitHubToken } = await import("../github/auth.js");
    const token = await resolveGitHubToken(undefined);
    expect(token).toBe("env-token-123");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/github-auth.test.ts`
Expected: FAIL with "Cannot find module"

**Step 3: Write minimal implementation**

Create `ix-cli/src/cli/github/auth.ts`:

```typescript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolve a GitHub token using this priority:
 * 1. Explicit --token flag
 * 2. GITHUB_TOKEN environment variable
 * 3. `gh auth token` CLI command
 */
export async function resolveGitHubToken(explicitToken?: string): Promise<string> {
  if (explicitToken) return explicitToken;

  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // gh not installed or not authenticated
  }

  throw new Error(
    "GitHub authentication required. Provide one of:\n" +
    "  --token <pat>           Personal access token\n" +
    "  GITHUB_TOKEN=<pat>      Environment variable\n" +
    "  gh auth login           GitHub CLI authentication"
  );
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/__tests__/github-auth.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ix-cli/src/cli/github/auth.ts ix-cli/src/cli/__tests__/github-auth.test.ts
git commit -m "feat: add GitHub auth resolution (token flag → env → gh CLI)"
```

---

### Task 4: Add GitHub API Fetcher

**Files:**
- Create: `ix-cli/src/cli/github/fetch.ts`
- Test: `ix-cli/src/cli/__tests__/github-fetch.test.ts`

**Step 1: Write the failing test**

Create `ix-cli/src/cli/__tests__/github-fetch.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("parseGitHubRepo", () => {
  it("parses owner/repo format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(parseGitHubRepo("ix-infrastructure/IX-Memory")).toEqual({
      owner: "ix-infrastructure",
      repo: "IX-Memory",
    });
  });

  it("throws on invalid format", async () => {
    const { parseGitHubRepo } = await import("../github/fetch.js");
    expect(() => parseGitHubRepo("invalid")).toThrow();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/github-fetch.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `ix-cli/src/cli/github/fetch.ts`:

```typescript
export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepo(input: string): GitHubRepo {
  const parts = input.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${input}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  user: { login: string } | null;
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  html_url: string;
  comments: number;
}

export interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  state: string;
  merged_at: string | null;
  user: { login: string } | null;
  base: { ref: string };
  head: { ref: string };
  created_at: string;
  updated_at: string;
  html_url: string;
  changed_files?: number;
}

export interface GitHubCommit {
  sha: string;
  commit: { message: string; author: { name: string; date: string } | null };
  html_url: string;
  files?: { filename: string; status: string }[];
}

export interface GitHubComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at: string;
  html_url: string;
}

export interface GitHubFetchResult {
  issues: GitHubIssue[];
  issueComments: Map<number, GitHubComment[]>;
  pullRequests: GitHubPR[];
  prComments: Map<number, GitHubComment[]>;
  commits: GitHubCommit[];
}

async function ghFetch<T>(url: string, token: string): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub API ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export async function fetchGitHubData(
  repo: GitHubRepo,
  token: string,
  opts: { since?: string; limit?: number }
): Promise<GitHubFetchResult> {
  const { owner, repo: repoName } = repo;
  const base = `https://api.github.com/repos/${owner}/${repoName}`;
  const limit = opts.limit ?? 50;
  const sinceParam = opts.since ? `&since=${opts.since}` : "";

  // Fetch issues (excludes PRs with is:issue filter via state param)
  const issues = await ghFetch<GitHubIssue[]>(
    `${base}/issues?state=all&per_page=${limit}&sort=updated&direction=desc${sinceParam}`,
    token
  );
  // GitHub /issues includes PRs — filter them out
  const realIssues = issues.filter((i: any) => !i.pull_request);

  // Fetch PRs
  const pullRequests = await ghFetch<GitHubPR[]>(
    `${base}/pulls?state=all&per_page=${limit}&sort=updated&direction=desc`,
    token
  );

  // Fetch commits
  const commitLimit = Math.min(limit * 2, 100);
  const commits = await ghFetch<GitHubCommit[]>(
    `${base}/commits?per_page=${commitLimit}${sinceParam}`,
    token
  );

  // Fetch comments for top issues (max 10 to avoid rate limits)
  const issueComments = new Map<number, GitHubComment[]>();
  for (const issue of realIssues.slice(0, 10)) {
    if (issue.comments > 0) {
      try {
        const comments = await ghFetch<GitHubComment[]>(
          `${base}/issues/${issue.number}/comments?per_page=10`,
          token
        );
        issueComments.set(issue.number, comments);
      } catch { /* skip on error */ }
    }
  }

  // Fetch review comments for top PRs (max 10)
  const prComments = new Map<number, GitHubComment[]>();
  for (const pr of pullRequests.slice(0, 10)) {
    try {
      const comments = await ghFetch<GitHubComment[]>(
        `${base}/pulls/${pr.number}/comments?per_page=10`,
        token
      );
      if (comments.length > 0) {
        prComments.set(pr.number, comments);
      }
    } catch { /* skip on error */ }
  }

  return { issues: realIssues, issueComments, pullRequests, prComments, commits };
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/__tests__/github-fetch.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ix-cli/src/cli/github/fetch.ts ix-cli/src/cli/__tests__/github-fetch.test.ts
git commit -m "feat: add GitHub API fetcher for issues, PRs, commits"
```

---

### Task 5: Add GitHub-to-GraphPatch Transformer

**Files:**
- Create: `ix-cli/src/cli/github/transform.ts`
- Test: `ix-cli/src/cli/__tests__/github-transform.test.ts`

**Step 1: Write the failing test**

Create `ix-cli/src/cli/__tests__/github-transform.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("GitHub transform", () => {
  it("creates deterministic node IDs from URIs", async () => {
    const { deterministicId } = await import("../github/transform.js");
    const id1 = deterministicId("github://owner/repo/issues/1");
    const id2 = deterministicId("github://owner/repo/issues/1");
    const id3 = deterministicId("github://owner/repo/issues/2");
    expect(id1).toBe(id2); // same input = same ID
    expect(id1).not.toBe(id3); // different input = different ID
    // Should be valid UUID format
    expect(id1).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("transforms an issue into UpsertNode ops", async () => {
    const { transformIssue } = await import("../github/transform.js");
    const ops = transformIssue(
      { owner: "acme", repo: "app" },
      {
        number: 42,
        title: "Fix login bug",
        body: "Login fails on mobile",
        state: "open",
        user: { login: "alice" },
        labels: [{ name: "bug" }],
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-02T00:00:00Z",
        html_url: "https://github.com/acme/app/issues/42",
        comments: 0,
      }
    );
    expect(ops.length).toBeGreaterThanOrEqual(1);
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("intent");
    expect(upsert!.name).toBe("Fix login bug");
  });

  it("transforms a PR into UpsertNode ops with decision kind", async () => {
    const { transformPR } = await import("../github/transform.js");
    const ops = transformPR(
      { owner: "acme", repo: "app" },
      {
        number: 10,
        title: "Add auth flow",
        body: "Implements OAuth",
        state: "closed",
        merged_at: "2026-01-05T00:00:00Z",
        user: { login: "bob" },
        base: { ref: "main" },
        head: { ref: "feature/auth" },
        created_at: "2026-01-03T00:00:00Z",
        updated_at: "2026-01-05T00:00:00Z",
        html_url: "https://github.com/acme/app/pull/10",
        changed_files: 5,
      }
    );
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("decision");
    expect(upsert!.name).toBe("Add auth flow");
  });

  it("transforms a commit into UpsertNode ops with doc kind", async () => {
    const { transformCommit } = await import("../github/transform.js");
    const ops = transformCommit(
      { owner: "acme", repo: "app" },
      {
        sha: "abc123def456",
        commit: { message: "fix: resolve null pointer", author: { name: "carol", date: "2026-01-04T00:00:00Z" } },
        html_url: "https://github.com/acme/app/commit/abc123def456",
        files: [{ filename: "src/auth.ts", status: "modified" }],
      }
    );
    const upsert = ops.find((op: any) => op.type === "UpsertNode");
    expect(upsert).toBeDefined();
    expect(upsert!.kind).toBe("doc");
    expect(upsert!.name).toContain("fix: resolve null pointer");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/__tests__/github-transform.test.ts`
Expected: FAIL

**Step 3: Write implementation**

Create `ix-cli/src/cli/github/transform.ts`:

```typescript
import { createHash } from "node:crypto";
import type { PatchOp } from "../../client/types.js";
import type { GitHubRepo, GitHubIssue, GitHubPR, GitHubCommit, GitHubComment } from "./fetch.js";

/** Generate a deterministic UUID v5-like ID from a string. */
export function deterministicId(input: string): string {
  const hash = createHash("sha256").update(input).digest("hex");
  // Format as UUID: 8-4-4-4-12
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32),
  ].join("-");
}

function truncate(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max) + "..." : s;
}

export function transformIssue(repo: GitHubRepo, issue: GitHubIssue): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/issues/${issue.number}`;
  const nodeId = deterministicId(uri);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "intent",
      name: issue.title,
      attrs: {
        number: issue.number,
        url: issue.html_url,
        author: issue.user?.login ?? "unknown",
        labels: issue.labels.map(l => l.name),
        state: issue.state,
        created_at: issue.created_at,
        body: truncate(issue.body, 2000),
        source_uri: uri,
      },
    },
  ];
  return ops;
}

export function transformIssueComment(
  repo: GitHubRepo,
  issueNumber: number,
  comment: GitHubComment
): PatchOp[] {
  const parentUri = `github://${repo.owner}/${repo.repo}/issues/${issueNumber}`;
  const commentUri = `${parentUri}/comments/${comment.id}`;
  const parentId = deterministicId(parentUri);
  const commentId = deterministicId(commentUri);
  const edgeId = deterministicId(`${parentUri}:CONTAINS:${commentUri}`);

  return [
    {
      type: "UpsertNode",
      id: commentId,
      kind: "doc",
      name: `Issue #${issueNumber} comment by ${comment.user?.login ?? "unknown"}`,
      attrs: {
        url: comment.html_url,
        author: comment.user?.login ?? "unknown",
        created_at: comment.created_at,
        body: truncate(comment.body, 2000),
        source_uri: commentUri,
      },
    },
    {
      type: "UpsertEdge",
      id: edgeId,
      src: parentId,
      dst: commentId,
      predicate: "CONTAINS",
      attrs: {},
    },
  ];
}

export function transformPR(repo: GitHubRepo, pr: GitHubPR): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/pull/${pr.number}`;
  const nodeId = deterministicId(uri);
  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "decision",
      name: pr.title,
      attrs: {
        number: pr.number,
        url: pr.html_url,
        author: pr.user?.login ?? "unknown",
        state: pr.state,
        merged: !!pr.merged_at,
        base_branch: pr.base.ref,
        head_branch: pr.head.ref,
        created_at: pr.created_at,
        changed_files_count: pr.changed_files,
        body: truncate(pr.body, 2000),
        rationale: truncate(pr.body, 500),
        source_uri: uri,
      },
    },
  ];
  return ops;
}

export function transformPRComment(
  repo: GitHubRepo,
  prNumber: number,
  comment: GitHubComment
): PatchOp[] {
  const parentUri = `github://${repo.owner}/${repo.repo}/pull/${prNumber}`;
  const commentUri = `${parentUri}/comments/${comment.id}`;
  const parentId = deterministicId(parentUri);
  const commentId = deterministicId(commentUri);
  const edgeId = deterministicId(`${parentUri}:CONTAINS:${commentUri}`);

  return [
    {
      type: "UpsertNode",
      id: commentId,
      kind: "doc",
      name: `PR #${prNumber} review by ${comment.user?.login ?? "unknown"}`,
      attrs: {
        url: comment.html_url,
        author: comment.user?.login ?? "unknown",
        created_at: comment.created_at,
        body: truncate(comment.body, 2000),
        source_uri: commentUri,
      },
    },
    {
      type: "UpsertEdge",
      id: edgeId,
      src: parentId,
      dst: commentId,
      predicate: "CONTAINS",
      attrs: {},
    },
  ];
}

export function transformCommit(repo: GitHubRepo, commit: GitHubCommit): PatchOp[] {
  const uri = `github://${repo.owner}/${repo.repo}/commit/${commit.sha}`;
  const nodeId = deterministicId(uri);
  const message = commit.commit.message.split("\n")[0]; // first line only for name

  const ops: PatchOp[] = [
    {
      type: "UpsertNode",
      id: nodeId,
      kind: "doc",
      name: message,
      attrs: {
        sha: commit.sha,
        url: commit.html_url,
        author: commit.commit.author?.name ?? "unknown",
        created_at: commit.commit.author?.date,
        message: truncate(commit.commit.message, 2000),
        changed_files: commit.files?.map(f => f.filename) ?? [],
        source_uri: uri,
      },
    },
  ];

  // Add REFERENCES edges to changed files
  if (commit.files) {
    for (const file of commit.files) {
      const fileNodeId = deterministicId(`${repo.owner}/${repo.repo}::${file.filename}`);
      const edgeId = deterministicId(`${uri}:REFERENCES:${file.filename}`);
      ops.push({
        type: "UpsertEdge",
        id: edgeId,
        src: nodeId,
        dst: fileNodeId,
        predicate: "REFERENCES",
        attrs: { change_type: file.status },
      });
    }
  }

  return ops;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/__tests__/github-transform.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add ix-cli/src/cli/github/transform.ts ix-cli/src/cli/__tests__/github-transform.test.ts
git commit -m "feat: add GitHub-to-GraphPatch transformer (issues→intent, PRs→decision, commits→doc)"
```

---

### Task 6: Add `--github` Flag to Ingest Command

**Files:**
- Modify: `ix-cli/src/cli/commands/ingest.ts:1-65`

**Step 1: Add the --github flag and wire everything together**

Replace the entire contents of `ix-cli/src/cli/commands/ingest.ts`:

```typescript
import * as nodePath from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { IxClient } from "../../client/api.js";
import type { GraphPatchPayload } from "../../client/types.js";
import { getEndpoint, resolveWorkspaceRoot } from "../config.js";
import { resolveGitHubToken } from "../github/auth.js";
import { parseGitHubRepo, fetchGitHubData } from "../github/fetch.js";
import {
  deterministicId,
  transformIssue,
  transformIssueComment,
  transformPR,
  transformPRComment,
  transformCommit,
} from "../github/transform.js";

export function registerIngestCommand(program: Command): void {
  program
    .command("ingest [path]")
    .description("Ingest source files or GitHub data into the knowledge graph")
    .option("--recursive", "Recursively ingest directory")
    .option("--github <owner/repo>", "Ingest issues, PRs, and commits from a GitHub repository")
    .option("--token <pat>", "GitHub personal access token")
    .option("--since <date>", "Only fetch items updated after this date (ISO 8601)")
    .option("--limit <n>", "Max items per category (default 50)", "50")
    .option("--format <fmt>", "Output format (text|json)", "text")
    .option("--root <dir>", "Workspace root directory")
    .addHelpText("after", "\nExamples:\n  ix ingest ./src --recursive\n  ix ingest --github owner/repo\n  ix ingest --github owner/repo --since 2026-01-01 --limit 20 --format json\n  ix ingest --github owner/repo --token ghp_xxxx")
    .action(async (path: string | undefined, opts: {
      recursive?: boolean; github?: string; token?: string;
      since?: string; limit: string; format: string; root?: string
    }) => {
      if (opts.github) {
        await ingestGitHub(opts);
      } else if (path) {
        await ingestFiles(path, opts);
      } else {
        console.error("Error: provide a <path> or use --github <owner/repo>");
        process.exit(1);
      }
    });
}

async function ingestFiles(
  path: string,
  opts: { recursive?: boolean; format: string; root?: string }
): Promise<void> {
  const resolvedPath = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(resolveWorkspaceRoot(opts.root), path);
  const client = new IxClient(getEndpoint());
  const start = performance.now();

  const spinner = ["\u28CB", "\u28D9", "\u28F9", "\u28F8", "\u28FC", "\u28F4", "\u28E6", "\u28E7", "\u28C7", "\u28CF"];
  let spinIdx = 0;
  const interval = opts.format === "text" ? setInterval(() => {
    const elapsed = ((performance.now() - start) / 1000).toFixed(0);
    process.stderr.write(`\r${spinner[spinIdx++ % spinner.length]} Ingesting... ${elapsed}s`);
  }, 200) : null;

  try {
    const result = await client.ingest(resolvedPath, opts.recursive);
    if (interval) {
      clearInterval(interval);
      process.stderr.write("\r" + " ".repeat(40) + "\r");
    }
    const elapsed = ((performance.now() - start) / 1000).toFixed(2);

    if (opts.format === "json") {
      console.log(JSON.stringify({ ...result, elapsedSeconds: parseFloat(elapsed) }, null, 2));
    } else {
      console.log(chalk.bold("\nIngest summary"));
      console.log(`  processed:   ${result.patchesApplied} files (${elapsed}s)`);
      console.log(`  discovered:  ${result.filesProcessed} files`);
      if (result.skipReasons) {
        const sr = result.skipReasons;
        if (sr.unchanged > 0) console.log(`  ${chalk.dim("skipped unchanged:")} ${sr.unchanged}`);
        if (sr.emptyFile > 0) console.log(`  ${chalk.dim("skipped empty:")}     ${sr.emptyFile}`);
        if (sr.parseError > 0) console.log(`  ${chalk.red("parse errors:")}      ${sr.parseError}`);
        if (sr.tooLarge > 0) console.log(`  ${chalk.dim("skipped too large:")} ${sr.tooLarge}`);
      } else if (result.filesSkipped) {
        console.log(`  ${chalk.dim("skipped:")}  ${result.filesSkipped} unchanged files`);
      }
      console.log(`  rev:         ${result.latestRev}`);

      if (result.patchesApplied === 0 && result.filesProcessed === 0) {
        console.log(chalk.yellow("\n  Warning: No files ingested. The path may be outside the project root,"));
        console.log(chalk.yellow("    contain no supported file types, or not exist."));
      } else if (result.patchesApplied === 0 && result.filesProcessed > 0) {
        console.log(chalk.dim("\n  All files unchanged since last ingest."));
      }
      console.log();
    }
  } finally {
    if (interval) clearInterval(interval);
  }
}

async function ingestGitHub(opts: {
  github?: string; token?: string; since?: string;
  limit: string; format: string
}): Promise<void> {
  const repo = parseGitHubRepo(opts.github!);
  const token = await resolveGitHubToken(opts.token);
  const client = new IxClient(getEndpoint());
  const limit = parseInt(opts.limit, 10);
  const start = performance.now();

  // Default --since to 30 days ago
  const since = opts.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  if (opts.format !== "json") {
    process.stderr.write(`Fetching from ${repo.owner}/${repo.repo} (since ${since})...\n`);
  }

  const data = await fetchGitHubData(repo, token, { since, limit });

  // Build all patch ops
  const allOps: any[] = [];

  for (const issue of data.issues) {
    allOps.push(...transformIssue(repo, issue));
  }
  for (const [issueNum, comments] of data.issueComments) {
    for (const comment of comments) {
      allOps.push(...transformIssueComment(repo, issueNum, comment));
    }
  }
  for (const pr of data.pullRequests) {
    allOps.push(...transformPR(repo, pr));
  }
  for (const [prNum, comments] of data.prComments) {
    for (const comment of comments) {
      allOps.push(...transformPRComment(repo, prNum, comment));
    }
  }
  for (const commit of data.commits) {
    allOps.push(...transformCommit(repo, commit));
  }

  // Submit as a single patch
  const patch: GraphPatchPayload = {
    patchId: deterministicId(`github://${repo.owner}/${repo.repo}:${since}:${Date.now()}`),
    actor: "ix/github-ingest",
    timestamp: new Date().toISOString(),
    source: {
      uri: `github://${repo.owner}/${repo.repo}`,
      extractor: "github-ingest/1.0",
      sourceType: "comment",
    },
    baseRev: 0,
    ops: allOps,
    replaces: [],
    intent: `GitHub ingestion: ${repo.owner}/${repo.repo}`,
  };

  const result = await client.commitPatch(patch);
  const elapsed = ((performance.now() - start) / 1000).toFixed(2);

  if (opts.format === "json") {
    console.log(JSON.stringify({
      source: `${repo.owner}/${repo.repo}`,
      issues: data.issues.length,
      pullRequests: data.pullRequests.length,
      commits: data.commits.length,
      issueComments: [...data.issueComments.values()].reduce((s, c) => s + c.length, 0),
      prComments: [...data.prComments.values()].reduce((s, c) => s + c.length, 0),
      totalOps: allOps.length,
      rev: result.rev,
      status: result.status,
      elapsedSeconds: parseFloat(elapsed),
    }, null, 2));
  } else {
    console.log(chalk.bold("\nGitHub ingest summary"));
    console.log(`  repo:            ${repo.owner}/${repo.repo}`);
    console.log(`  issues:          ${data.issues.length}`);
    console.log(`  pull requests:   ${data.pullRequests.length}`);
    console.log(`  commits:         ${data.commits.length}`);
    const issueCommentCount = [...data.issueComments.values()].reduce((s, c) => s + c.length, 0);
    const prCommentCount = [...data.prComments.values()].reduce((s, c) => s + c.length, 0);
    if (issueCommentCount > 0) console.log(`  issue comments:  ${issueCommentCount}`);
    if (prCommentCount > 0) console.log(`  PR comments:     ${prCommentCount}`);
    console.log(`  total ops:       ${allOps.length}`);
    console.log(`  rev:             ${result.rev}`);
    console.log(`  elapsed:         ${elapsed}s`);
    console.log();
  }
}
```

**Step 2: Build**

Run: `cd ix-cli && npm run build`
Expected: Compiles successfully

**Step 3: Commit**

```bash
git add ix-cli/src/cli/commands/ingest.ts
git commit -m "feat: add --github flag to ix ingest for GitHub repo ingestion"
```

---

### Task 7: Run Full Test Suite and Fix

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

**Step 2: If any test fails, fix it**

The ingest command changed from `ingest <path>` to `ingest [path]` (optional). Check if any existing tests reference the old signature.

**Step 3: Commit fixes if needed**

```bash
git add -A
git commit -m "fix: update tests for optional ingest path"
```

---

### Task 8: Update Docs

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`
- Modify: `README.md`

**Step 1: Add GitHub ingestion to CLAUDE.md routing table**

In the `### Ingestion & Health` section, add:

```
| Ingest GitHub data | `ix ingest` | `ix ingest --github owner/repo --limit 50` |
```

**Step 2: Add to AGENTS.md**

In the command routing section, add under "### Ingesting data":

```
ix ingest --github owner/repo --format json --limit 50
ix ingest --github owner/repo --since 2026-01-01 --format json
```

**Step 3: Add to README.md core commands**

Add a row for `ix ingest --github` in the commands table.

**Step 4: Commit**

```bash
git add CLAUDE.md AGENTS.md README.md
git commit -m "docs: add GitHub ingestion to CLI routing guides"
```

---

### Task 9: Push

**Step 1: Push all commits**

```bash
git push origin feature/ix-redesign
```
