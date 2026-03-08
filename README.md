# Ix Memory

Ix Memory is a local, versioned knowledge graph for codebases.

It has two runtime parts:
- `memory-layer` (Scala HTTP API)
- `ix-cli` (TypeScript CLI; canonical interface)

MCP is still present for compatibility, but the primary interface is `ix` CLI commands.

## What It Supports Today

- File ingestion: `.py`, `.ts`, `.tsx`, `.scala`, `.sc`, `.json`, `.yaml`, `.yml`, `.toml`, `.md`
- Graph navigation: search, explain, callers/callees, imports/imported-by, contains, depends
- Decision and intent tracking: `ix decide`, `ix decisions`, `ix truth ...`
- Provenance + history: `ix patches`, `ix history`, `ix diff`, `ix conflicts`
- GitHub ingestion: `ix ingest --github owner/repo` (issues/PRs/commits/comments)

## Prerequisites

| Tool | Version |
|---|---|
| Java | 17+ |
| sbt | 1.x |
| Docker | 20+ |
| Node.js | 18+ |
| npm | 9+ |

## Install And Start

From repo root:

```bash
./setup.sh
```

What this does:
- Starts backend services (`arangodb` + `memory-layer`) via `scripts/backend.sh`
- Builds CLI (`ix-cli`) via `scripts/build-cli.sh`
- Installs a global `ix` command at `~/.local/bin/ix`
- Ensures `~/.local/bin` is on your PATH in `~/.bashrc` / `~/.zshrc`

Optional flags:

```bash
./setup.sh --skip-backend
./setup.sh --skip-global-ix
```

### Verify

```bash
./scripts/backend.sh check
ix status
```

If `ix` is not found in your current shell, reload your shell or run:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Connect A Project

### Fast path

```bash
./scripts/connect.sh /path/to/your/project
```

### Manual path

```bash
cd /path/to/your/project
ix init
ix ingest ./src --recursive
```

## Core Usage

All commands support `--format json`.

```bash
ix status
ix ingest ./src --recursive
ix search IngestionService --kind class --format json
ix explain IngestionService --format json
ix callers parseFile --format json
ix callees parseFile --format json
ix imports IngestionService --format json
ix imported-by IngestionService --format json
ix contains IngestionService --format json
ix depends IngestionService --depth 2 --format json
ix read src/main/scala/ix/memory/Main.scala:1-80
ix text "commitPatch" --language ts --limit 20 --format json
```

## GitHub Ingestion

```bash
ix ingest --github owner/repo --since 2026-01-01 --limit 50 --format json
```

Auth resolution order:
1. `--token <pat>`
2. `GITHUB_TOKEN`
3. `gh auth token`

## Useful Scripts

| Script | Purpose |
|---|---|
| `./setup.sh` | Start backend + build CLI + install global `ix` |
| `./scripts/backend.sh up` | Start backend |
| `./scripts/backend.sh down` | Stop backend |
| `./scripts/backend.sh logs` | Tail logs |
| `./scripts/backend.sh clean` | Remove volumes/data |
| `./scripts/build-cli.sh` | Build CLI |
| `./scripts/connect.sh <dir>` | Connect project + ingest |
| `./scripts/disconnect.sh <dir>` | Remove project config |
| `./scripts/ingest.sh [path]` | Ingest helper |

## Testing

CLI:

```bash
cd ix-cli
npm test
```

Backend:

```bash
# Requires ArangoDB running on localhost:8529
sbt memoryLayer/test
```

## Known Notes

- Many Scala tests require a live ArangoDB instance; if it is down, DB/API/E2E specs fail.
- `TreeSitterPythonParser` still contains a TODO for full AST traversal fallback behavior.
- `ix query` remains available but is deprecated in help text and templates.
- `connect.sh` still sets MCP config for IDE compatibility; CLI remains canonical.

## Architecture

```text
ix-cli  --->  memory-layer (http4s)  --->  ArangoDB
   \
    \--> mcp server (compatibility mode)
```

## License

Proprietary — IX Infrastructure.
