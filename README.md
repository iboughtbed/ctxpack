# ctxpack

ctxpack is a Bun + Turborepo monorepo for providing external codebase context to agents.

It includes:

- `apps/honojs`: Hono backend + MCP server
- `apps/cli`: CLI (OpenTUI/Solid.js) for local workflows
- `apps/nextjs`: web dashboard (lower priority)
- `packages/db`: Drizzle + PostgreSQL/pgvector

## Local-First Architecture

Local mode is the current priority.

- Content sync and vector indexing are separated.
- Text tools (`list`, `grep`, `read`, `glob`) are independent of vector embeddings.
- CLI forwards model/provider keys per request to Hono via headers.
- Server startup values are fallback defaults; request headers can override without restart.

## Quick Start

### 1. Start server (with logs)

```bash
bun run cli:run -- serve
```

### 2. Connect provider

```bash
bun run cli:run -- connect openai
```

### 3. Add and index local resource

```bash
bun run cli:run -- add . --type local --paths ./apps/honojs --name ctxpack-hono-local --index
```

## Core Commands

### Setup and config

```bash
bun run cli:run -- setup --force
bun run cli:run -- config
```

### Resources

```bash
bun run cli:run -- list
bun run cli:run -- add <url-or-path> [--type git|local] [--paths <a,b>] [--name <name>] [--index]
bun run cli:run -- sync <resource-id|name>
bun run cli:run -- index <resource-id|name>
bun run cli:run -- updates
```

### Search modes

```bash
bun run cli:run -- search "<query>"                    # quick AI answer
bun run cli:run -- search "<query>" --raw              # raw ranked chunks, no AI
bun run cli:run -- search "<query>" --explore          # agent mode
bun run cli:run -- search "<query>" --research         # deep research mode
```

Common options:

```bash
--mode <hybrid|text|vector>
--resource, -r <name-or-id>
--top-k <n>
--alpha <0-1>
--stream
--verbose, -v
```

## Streaming and Logging Test Matrix

Run server in one terminal:

```bash
bun run cli:run -- serve
```

Run client commands in another terminal:

```bash
# 1) quick answer, non-stream
bun run cli:run -- search "How are code chunks embedded with AI SDK?" --mode text -v

# 2) quick answer, stream
bun run cli:run -- search "How are code chunks embedded with AI SDK?" --mode text --stream -v

# 3) explore, non-stream
bun run cli:run -- search "Trace indexing pipeline from sync to embeddings" --explore --mode hybrid -v

# 4) explore, stream
bun run cli:run -- search "Trace indexing pipeline from sync to embeddings" --explore --mode hybrid --stream -v

# 5) research, non-stream
bun run cli:run -- search "Compare text search and vector search paths" --research --mode hybrid -v

# 6) research, stream
bun run cli:run -- search "Compare text search and vector search paths" --research --mode hybrid --stream -v

# 7) raw baseline (no LLM)
bun run cli:run -- search "embeddingModel" --raw --mode text --top-k 20 -v
```

Optional verbose runtime diagnostics:

```bash
DEBUG=* bun run cli:run -- search "<query>" --explore --stream -v
```

## Tool Commands (Text Path Validation)

```bash
bun run cli:run -- list --resource <name-or-id> --path src
bun run cli:run -- grep "streamText|generateText|instructions|store|stream" --resource <name-or-id>
bun run cli:run -- read src/lib/models.ts --resource <name-or-id> --start-line 1 --end-line 260
bun run cli:run -- glob "**/*search*.ts" --resource <name-or-id>
```

## Authentication Interop (ctxpack + OpenCode)

OpenAI auth is stored in ctxpack and mirrored to OpenCode-compatible storage:

- Linux/macOS (XDG): `~/.local/share/opencode/auth.json`
- Windows: `%APPDATA%/opencode/auth.json`

Check credentials:

```bash
bun run cli:run -- auth status
```

Logout:

```bash
bun run cli:run -- auth logout openai
```

## Notes

- Embeddings still require API-key-capable provider credentials.
- If you change provider/model config via CLI, per-request headers apply immediately; server restart is not required for those request-level overrides.
