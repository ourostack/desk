---
schema_version: 1
title: "Retry limit reply on the fix pull request"
status: in_progress
created: "2026-11-12T09:00:00Z"
updated: "2026-11-13T18:00:00Z"
track: posts-site
repos: ["alex-example/posts-site"]
---

# Retry limit reply on the fix pull request

Pull request: https://github.com/alex-example/posts-site/pull/7. It is open, and its description is the one drafted for it.

## Review thread

- Comment 9876543 on `src/retry.js`: the reviewer asked why the retry limit is three.

## Drafted reply

"Three attempts in total: the first try and two retries. Two retries cover the usual brief drop. A third retry mostly adds load when the upstream is already down, so `RETRY_LIMIT` stays at three."

## Before posting

- Voice tests and a zero-context review of the drafted reply are still to run.
- Not posted yet.
