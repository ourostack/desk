---
schema_version: 1
title: "Build the index page"
status: in_progress
created: "2026-11-12T09:00:00Z"
updated: "2026-11-13T12:20:00Z"
track: posts-site
repos: ["alex-example/posts-site"]
---

# Build the index page

A tool that builds the index page from the posts folder, with tests passing and the output checked.

## Evidence so far

- 2026-11-13 10:12: `npm test` passed.
- 2026-11-13 11:40: an independent review of the index-page commit returned two findings: a missing test for an empty posts folder, and an unclear error for a post with no date. Both fixed.
- 2026-11-13 12:05: `npm test` passed again.
- 2026-11-13 12:20: `site/index.html` checked by eye. It lists the posts in order.

## Next

- Commit and open the pull request after Alex's go.
