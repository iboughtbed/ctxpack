# ctxpack CLI

## Run locally

```bash
bun run dev
```

## Setup flow

```bash
ctxpack
ctxpack setup
```

Running `ctxpack` with no arguments shows setup status. Run `ctxpack setup` to create `./ctxpack.config.jsonc`.

## Core commands

```bash
ctxpack connect --provider openai
ctxpack disconnect --provider openai
ctxpack config
ctxpack server
ctxpack resources
ctxpack add https://github.com/acme/repo --type git --name acme-repo
ctxpack sync acme-repo
ctxpack index acme-repo --sync
ctxpack ask "auth middleware"
ctxpack search "auth middleware" --raw
ctxpack ls --resource acme-repo --path src
```

Use `ctxpack ask` as the default query command. Use `ctxpack search` for explicit modes like `--raw` or `--research`.

## Remote commands

```bash
ctxpack remote link --key <api-key> --endpoint https://api.example.com
ctxpack remote resources
ctxpack remote ask --query "..."
ctxpack remote unlink
```
