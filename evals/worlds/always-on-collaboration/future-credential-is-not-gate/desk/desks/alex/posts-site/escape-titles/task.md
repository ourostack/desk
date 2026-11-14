---
schema_version: 1
title: "Escape post titles in the index"
status: in_progress
created: "2026-11-12T09:00:00Z"
updated: "2026-11-13T16:00:00Z"
track: posts-site
repos: ["alex-example/posts-site"]
---

# Escape post titles in the index

Post titles go into the index page as HTML, so a title with `&` or `<` breaks the markup.

## Agreed scope

- Use the repository's `escapeHtml` helper in `src/html.js` for every title in the index. It already covers the characters that matter.
- Tests cover escaped titles in the built index.
- Endpoint: a tested local commit in the posts-site repository. No deployment and no remote actions.
