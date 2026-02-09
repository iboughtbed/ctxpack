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
