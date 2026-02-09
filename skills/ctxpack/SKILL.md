---
name: ctxpack
description: Index and search code repositories, local folders, and codebases. Provides context via text, vector, and hybrid search with agent exploration, deep research, and direct file access. Use when you need context from external codebases, repositories, or local projects.
metadata:
  author: x.com/iboughtbed
  version: "1.1.2"
---

# ctxpack

Local-first CLI for indexing codebases and retrieving context for agents.

## Requirements

- `bun>=1.3.0`
- `ripgrep` (rg)
- `docker`

## When to use

- You need to search code from external repos or local folders.
- You need hybrid/text/vector retrieval with optional agent exploration.
- You need direct file access over indexed resources (`ls`, `grep`, `read`, `glob`).

Example triggers:

```text
"Find where auth middleware is enforced in repo X."
"Trace indexing pipeline and compare text vs vector retrieval."
"Read src/lib/search.ts around score fusion logic."
```

## Bootstrap (fresh project)

```bash
ctxpack                # Show setup status
ctxpack setup          # Create ./ctxpack.config.jsonc if missing
ctxpack skill          # Install skill: npx skills add iboughtbed/ctxpack --skill ctxpack
ctxpack connect openai # OAuth flow; or: ctxpack connect --provider <id> ...
ctxpack serve          # Start local server (default http://localhost:8787)
```

## Core workflow

### 1. Add resources

```bash
ctxpack add <url-or-path> [--name <name>] [--type git|local] [--branch <branch>] [--commit <sha>] [--paths <a,b>] [--notes <text>] [--index] [--global]
```

```bash
ctxpack add https://github.com/acme/platform --type git --name acme-platform --index
ctxpack add ./services/api --type local --name api-local --paths src,package.json --index
```

### 2. Sync and index

```bash
ctxpack sync <name-or-id> [...] [--all] [--global]
ctxpack index <name-or-id> [...] [--all] [--sync] [--global]
ctxpack job <job-id>
```

```bash
ctxpack sync acme-platform
ctxpack index acme-platform --sync   # sync + index in one step
ctxpack job 6b0e3c66-2b27-4d75-9aa6-725a3e9f2b0f
```

### 3. Query

| Command                                     | Behavior                                               |
| ------------------------------------------- | ------------------------------------------------------ |
| `ctxpack ask <query>`                       | Agent-based exploration (alias for `search --explore`) |
| `ctxpack search <query>`                    | Quick AI-generated answer                              |
| `ctxpack search <query> --raw`              | Raw chunks only, no AI answer                          |
| `ctxpack search <query> --explore`          | Agent-based exploration                                |
| `ctxpack search <query> --research`         | Deep multi-step research                               |
| `ctxpack search <query> --research --async` | Background research job                                |
| `ctxpack research-status <job-id>`          | Poll async research status                             |

```bash
ctxpack ask "Where is request-level model config applied?" -r acme-platform
ctxpack search "hybrid score fusion" --raw -r acme-platform --top-k 8
ctxpack search "trace indexing pipeline" --research --async -r acme-platform
ctxpack research-status <job-id>
```

### 4. Direct file access

All direct file commands require `--resource`.

```bash
ctxpack ls --resource <name-or-id> [--path <subpath>]
ctxpack grep <pattern> --resource <name-or-id> [--paths a,b] [--case-sensitive]
ctxpack read <filepath> --resource <name-or-id> [--start-line N] [--end-line N]
ctxpack glob <pattern> --resource <name-or-id>
```

```bash
ctxpack ls --resource acme-platform --path apps/honojs/src
ctxpack grep "resolveModelConfig" --resource acme-platform --paths apps/cli/src
ctxpack read apps/cli/src/index.tsx --resource acme-platform --start-line 380 --end-line 470
ctxpack glob "**/*.test.ts" --resource acme-platform
```

## Key options

| Flag                            | Description                                       |
| ------------------------------- | ------------------------------------------------- |
| `--resource, -r <name-or-id>`   | Scope query to specific resource(s)               |
| `--mode <hybrid\|text\|vector>` | Retrieval mode (default: hybrid)                  |
| `--top-k <n>`                   | Max context chunks returned                       |
| `--alpha <0-1>`                 | Hybrid weighting (0 = text only, 1 = vector only) |
| `--stream`                      | Stream answer tokens and events                   |
| `--verbose, -v`                 | Include explore/research trace                    |
| `--global, -g`                  | Use global resource scope                         |
| `--endpoint <url>`              | Override API target                               |
| `--api-key <key>`               | Override API credentials                          |

```bash
ctxpack search "oauth fallback behavior" \
  --mode hybrid \
  --alpha 0.35 \
  --top-k 12 \
  --resource acme-platform \
  --stream \
  --verbose
```

## Remote mode

```bash
ctxpack remote link --key <api-key> [--endpoint <url>]
ctxpack remote unlink
ctxpack remote add ...
ctxpack remote resources
ctxpack remote ask ...
ctxpack remote rm <resource-id>
```

## Guardrails

- Run `ctxpack resources` to list available resources before querying.
- Prefer `ctxpack ask` for general QA; use `search` when you need explicit control over mode, raw output, or research depth.
- All direct file commands (`ls`, `grep`, `read`, `glob`) require `--resource`.
- Indexing into the vector database requires an API key for an embedding model (set via `ctxpack connect`).
