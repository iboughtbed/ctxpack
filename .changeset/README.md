# Changesets

Add a changeset for user-facing CLI changes:

```bash
bun run changeset
```

This generates a markdown file in `.changeset/`.
When merged to `main`, the release workflow creates/updates a Release PR.
Merging that PR publishes `ctxpack` to npm.
