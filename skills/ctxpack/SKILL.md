---
name: ctxpack
description: Index and search code repositories, local folders, and codebases with ctxpack. Provides external codebase context via text, vector, and hybrid search. Includes agent-based exploration, deep research, and direct file access tools. Use when you need context from external codebases, repositories, or local projects.
metadata:
  author: x.com/iboughtbed
  version: "1.0.0"
---

# ctxpack

Local-first tool for indexing code repositories and local folders, then searching them via text, vector, or hybrid search. Provides external codebase context to agents. Runs locally via `ctxpack serve`.

## Setup

### 1. Start local server

```bash
ctxpack serve [--port <n>]
```

### 2. Connect LLM provider (required for AI-powered search)

```bash
ctxpack connect         # Interactive provider select
ctxpack connect openai  # OpenAI via OAuth
ctxpack connect --provider <id> --model <id> [--api-key-env <ENV>]
```

### 3. Add a resource

```bash
ctxpack add <url-or-path> [--name <name>] [--type git|local] [--branch <branch>] [--commit <sha>] [--paths <a,b>] [--notes <text>] [--index]
```

Examples:

```bash
ctxpack add . --type local --paths ./src --name my-project --index
ctxpack add https://github.com/org/repo --name repo --index
```

## Resource Management

```bash
ctxpack list                              # List all resources
ctxpack rm <resource-id>                  # Remove a resource
ctxpack index <resource-id>               # Index a resource (embed for vector search)
ctxpack reindex <name-or-id> [...]        # Re-index (re-embeds; git repos also pull latest)
ctxpack reindex --all                     # Re-index all resources
ctxpack job <job-id>                      # Check indexing job status
```

## Search

Four modes, from fastest to most thorough:

```bash
ctxpack search <query>                    # Quick AI answer (~2-3s)
ctxpack search <query> --raw              # Raw ranked chunks, no AI
ctxpack search <query> --explore          # Agent-based exploration with tools (~10-30s)
ctxpack search <query> --research         # Deep research, 50 steps (~1-5min)
```

`ctxpack ask <query>` is an alias for `search --explore`.

### Search Options

```bash
--resource, -r <name-or-id>     # Scope to specific resource(s) (omit for all)
--mode <hybrid|text|vector>     # Search strategy (default: hybrid)
--stream                        # Stream response via SSE
--verbose, -v                   # Show agent trace (explore/research)
--top-k <n>                     # Max context chunks
--alpha <0-1>                   # Hybrid weight (0 = text only, 1 = vector only)
```

### Async Research

```bash
ctxpack search <query> --research --async   # Returns job ID
ctxpack research-status <job-id>            # Check result
```

## Tool Commands — Direct Resource Access

Navigate and read files in indexed resources directly. These work independently of vector indexing — text-only, no embeddings required.

```bash
ctxpack list --resource <name-or-id> [--path <subpath>]                          # List files
ctxpack grep <pattern> --resource <name-or-id> [--paths a,b] [--case-sensitive]  # Grep code
ctxpack read <filepath> --resource <name-or-id> [--start-line N] [--end-line N]  # Read file
ctxpack glob <pattern> --resource <name-or-id>                                   # Glob match
```

Use these tools to explore resource file trees, read specific files, and grep for patterns — gives the agent direct file system access over indexed codebases.

## Authentication

```bash
ctxpack auth status                # Show stored credentials
ctxpack auth logout [provider]     # Remove credentials
ctxpack disconnect                 # Disconnect LLM providers
```

Credentials stored in ctxpack auth, mirrored to OpenCode-compatible format:

- Linux/macOS: `~/.local/share/opencode/auth.json`
- Windows: `%APPDATA%/opencode/auth.json`

## Configuration

```bash
ctxpack setup [--force]            # Initialize/refresh project config
ctxpack config                     # Show/edit configuration
```

## Remote

Connect to a remote ctxpack server instead of running locally:

```bash
ctxpack remote link --key <api-key> [--endpoint <url>]
ctxpack remote unlink
ctxpack remote add ...
ctxpack remote list
ctxpack remote ask ...
ctxpack remote rm <resource-id>
```

## Global Options

```bash
--endpoint <url>    # Override API endpoint
--api-key <key>     # Override API key for this command
```

## Notes

- **Text tools work without vector indexing** — `list`, `grep`, `read`, `glob` only need synced content.
- **Embeddings require an API-key-capable provider** — OpenAI OAuth (ChatGPT Plus/Pro) supports chat/reasoning only, not embeddings.
- **Hybrid search** combines vector similarity with text grep for best results.
- **Model/provider overrides are per-request** — CLI forwards via headers, no server restart needed.
- **Content sync and vector indexing are separate** — syncing pulls files, indexing embeds them.
