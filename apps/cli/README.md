# ctxpack CLI

## Run locally

```bash
bun run dev
```

## Setup flow

```bash
ctxpack
```

Running `ctxpack` with no arguments bootstraps `./ctxpack.config.jsonc` and creates
default local storage directories under `~/.ctxpack/`.

## Core commands

```bash
ctxpack connect --provider openai --model text-embedding-3-small
ctxpack disconnect
ctxpack config
ctxpack server
ctxpack add https://github.com/acme/repo --type git --name acme-repo
ctxpack sync acme-repo
ctxpack index acme-repo
ctxpack updates
ctxpack ask --query "auth middleware"
```

## Remote commands

```bash
ctxpack remote link --key <api-key> --endpoint https://api.example.com
ctxpack remote list
ctxpack remote ask --query "..."
ctxpack remote unlink
```
