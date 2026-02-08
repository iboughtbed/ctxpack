---
"ctxpack": patch
---

Set up production release flow for the `ctxpack` CLI.

- package the CLI via `bin.js` and publish platform binaries from `dist/`
- add build/verify scripts for release artifacts
- add Changesets config and GitHub Actions for CI + automated npm releases
