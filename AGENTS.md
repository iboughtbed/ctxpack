# Codebase guide

## Monorepo overview

This is a bun + turborepo monorepo that has apps and packages related to our product.
It hosts an MCP server + backend, a Next.js dashboard, and a CLI app.

```
ctxpack/
├── apps
│ ├── honojs   # Hono backend + tmcp MCP server (HTTP + STDIO)
│ ├── nextjs   # Next.js dashboard (App Router)
│ └── cli      # OpenTUI CLI on Solid.js
├── packages
│ ├── auth     # better-auth configuration
│ ├── db       # drizzle-orm (schemas + postgres driver)
│ ├── sandbox  # sandbox api (for remote usage)
│ └── ...
└── tooling
  ├── eslint-config
  ├── prettier-config
  └── typescript-config
```

## Infrastructure overview

- **MCP server**: built with `tmcp`, exposed via HTTP and STDIO transports.
- **Backend API**: Hono app providing REST endpoints for indexing and search.
- **Indexing**: uses `code-chunk` (AST-aware chunking) and embeddings via Vercel AI SDK.
- **Vector storage**: PostgreSQL with `pgvector` (Dockerized for self-hosting).
- **Hybrid search**: combines vector similarity with grep/read over git-tracked files.
- **CLI**: OpenTUI-based app with Solid.js in `apps/cli` to trigger indexing/search.
- **Web app**: Next.js web app for using the backend service (low priority).

## Self-hosting and deployment

- **Docker**: self-host the Hono.js app via Docker.
- **Next.js on Vercel**: Next.js is hosted on Vercel (low priority).
- **CLI**: npx package is planned for running ctxpack.

## Running CLI and Hono

- **CLI**: run `bun run dev` in `apps/cli` locally (npx package is planned).
- **Hono**: run `bun run dev` in `apps/honojs` locally

## CLI commands

### Setup

```bash
bun run cli:run --              # Create ./ctxpack.config.jsonc (if missing)
bun run cli:run -- setup [--force]  # Initialize/refresh project config
```

### Authentication

```bash
bun run cli:run -- connect openai                              # Connect OpenAI via OAuth (ChatGPT Plus/Pro)
bun run cli:run -- connect                                     # Select provider interactively
bun run cli:run -- connect --provider <id> --model <id> [--api-key-env <ENV_NAME>]
bun run cli:run -- disconnect                                  # Disconnect LLM providers
bun run cli:run -- auth status                                 # Show stored auth credentials
bun run cli:run -- auth logout [provider]                     # Remove stored credentials
```

### Configuration

```bash
bun run cli:run -- config                                     # Show/edit configuration
```

### Server

```bash
bun run cli:run -- server [--port <n>]                        # Start local Hono server
bun run cli:run -- serve [--port <n>]                         # Alias for server
```

### Resource Management

```bash
bun run cli:run -- list                                        # List resources
bun run cli:run -- add <url-or-path> [--name <name>] [--type git|local] [--branch <branch>] [--commit <sha>] [--paths <a,b>] [--notes <text>] [--index]
bun run cli:run -- rm <resource-id>                           # Remove a resource
bun run cli:run -- index <resource-id>                        # Index a resource
bun run cli:run -- reindex <name-or-id> [...]                 # Re-index by name (re-embeds; git repos also pull latest)
bun run cli:run -- reindex --all                              # Re-index all resources
bun run cli:run -- job <job-id>                               # Check job status
```

### Search

```bash
# Quick AI answer from search results (~2-3s)
bun run cli:run -- search <query> [options]

# Raw ranked chunks, no AI
bun run cli:run -- search <query> --raw

# Agent-based exploration with tools (~10-30s)
bun run cli:run -- search <query> --explore

# Deep thorough research (50 steps, ~1-5min)
bun run cli:run -- search <query> --research

# Run research in background, returns job ID
bun run cli:run -- search <query> --research --async

# Alias for: search --explore
bun run cli:run -- ask <query> [options]

# Check async research job status
bun run cli:run -- research-status <job-id>

# Common search options:
#   --resource, -r <name-or-id>     Scope to specific resource(s) (omit for all)
#   --mode <hybrid|text|vector>      Search strategy (default: hybrid)
#   --stream                         Stream response
#   --verbose, -v                    Show agent trace (explore/research)
#   --top-k <n>                      Max context chunks
#   --alpha <0-1>                    Hybrid weight
```

### Tool Commands (Direct Resource Access)

```bash
bun run cli:run -- grep <pattern> --resource <name-or-id> [--paths a,b] [--case-sensitive]
bun run cli:run -- read <filepath> --resource <name-or-id> [--start-line N] [--end-line N]
bun run cli:run -- list --resource <name-or-id> [--path <subpath>]
bun run cli:run -- glob <pattern> --resource <name-or-id>
```

### Remote Aliases

```bash
bun run cli:run -- remote link --key <api-key> [--endpoint <url>]
bun run cli:run -- remote unlink
bun run cli:run -- remote add ...
bun run cli:run -- remote list
bun run cli:run -- remote ask ...
bun run cli:run -- remote rm <resource-id>
```

### Global Options for API Commands

```bash
--endpoint <url>   # Override API endpoint
--api-key <key>    # Override API key for this command
```
