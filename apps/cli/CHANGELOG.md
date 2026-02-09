# ctxpack

## 1.2.0

### Minor Changes

- f0f31f3: fix: dynamically load and create Hono.js server in CLI; and improve lifecycle and cleanup for CLI server

## 1.1.2

### Patch Changes

- e54225e: fix(cli): fix stream mode issues for models

## 1.1.1

### Patch Changes

- 2627d14: implement "skill" command to install a skill for agents

## 1.1.0

### Minor Changes

- 8018b12: Improve CLI commands and server pipeline with Docker containers for pgvector

## 1.0.3

### Patch Changes

- df6f93b: fix(cli): --version/-v/version output

## 1.0.2

### Patch Changes

- c719894: Republish CLI with a fresh version to recover from a broken npm tarball for 1.0.1.
  - keep CI publish flow on `npm publish ./apps/cli --access public`
  - ensure GitHub release entries are created through Changesets

## 1.0.1

### Patch Changes

- a8c3995: Set up production release flow for the `ctxpack` CLI.
  - package the CLI via `bin.js` and publish platform binaries from `dist/`
  - add build/verify scripts for release artifacts
  - add Changesets config and GitHub Actions for CI + automated npm releases
