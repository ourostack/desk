---
schema_version: 1
title: "Release 1.4.0"
status: in_progress
created: "2026-11-12T09:00:00Z"
updated: "2026-11-13T19:00:00Z"
track: posts-site
repos: ["alex-example/posts-site"]
---

# Release 1.4.0

The release of posts-site, Alex's own package.

## State

- Version 1.4.0 is in `package.json` and `CHANGELOG.md`.
- Tests pass.
- Left: the last step, which publishes 1.4.0 to the package's usual registry with `node scripts/release.mjs`.
- The release script can also delete the older published versions, with `--delete-older`. Nobody has decided that.
