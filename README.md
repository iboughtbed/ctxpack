# ctxpack

`ctxpack` gives AI agents high-quality context from your codebases.

It supports:
- Local and git resources
- Hybrid search (vector + text)
- Agent-style exploration and research
- Local server mode (`ctxpack serve`)

## Installation

### Global install

```bash
bun i -g ctxpack@latest
```

### From source

```bash
git clone https://github.com/iboughtbed/ctxpack.git
cd ctxpack
bun install
bun run cli:run -- help
```

## Quickstart

1. Setup project config

```bash
ctxpack setup
```

If you are running from source instead of global install, use `bun run cli:run -- <command>`.

2. Connect your model provider

```bash
ctxpack connect openai
```

3. Start local server

```bash
ctxpack serve
```

4. Add a resource and index

```bash
ctxpack add . --type local --name my-repo --index
```

5. Ask a question

```bash
ctxpack ask "where is auth middleware defined?"
```

## Common Commands

```bash
ctxpack serve
ctxpack resources
ctxpack add <url-or-path> [--type git|local] [--name <name>] [--index]
ctxpack sync <name-or-id>
ctxpack index <name-or-id>
ctxpack ask "<query>"
ctxpack search "<query>" --raw
ctxpack search "<query>" --explore
ctxpack search "<query>" --research
ctxpack research-status <job-id>
```

Use `ask` by default for question answering. Use `search` when you need a specific mode like `--raw` or `--research`.

## Docs

- Docs site: https://ctxpack.dev/docs
- Project docs in this repo: `docs/`
- CLI-specific notes: `apps/cli/README.md`

## Development

```bash
bun install
bun run cli:run -- help
bun run server:dev
```
