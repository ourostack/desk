---
name: preview-feedback
description: Record and publish a participant's qualitative feedback about an installed engineering preview as attributed Markdown in their own desk. Use only for preview feedback a participant explicitly offers, not ordinary task discussion, code review, telemetry, or automatic friction logging. There is no feedback MCP tool; preserved private records are never migrated into Git.
---

# Preview feedback

A participant's feedback about the preview is their own words, offered deliberately. Write it, when they ask for it, as Markdown in the participant's own desk at `_meta/preview-feedback.md` — under their person prefix when the session is person-bound, so `desks/<alias>/_meta/preview-feedback.md` — attributed to them and dated. This is explicit capture, not a background assessment of the person or their work.

There is no `desk_feedback` tool in this build, and no private feedback database to write into. Do not look for one, do not ask the host to enable one, and do not treat its absence as a failure to work around.

## Keep it explicit

Write only when the participant explicitly asks to record preview feedback. A complaint, a reviewer comment, or an observation during normal work is not consent to publish it. If they are only discussing the preview, respond to the substance without creating a record.

Keep their meaning and distinguish their own words from an agent-proposed summary. If a summary is needed, show it for confirmation before writing. Never add inferred effort, productivity, competence, or performance measurements. Do not attach logs, task contents, credentials, or unrelated conversation context.

Never fall back to `friction_add`, a lesson, a task card, another participant's desk, a shared decisions directory, an issue, a channel, or a collector if the intended destination is unavailable. Report the actual failure; a substitute destination the participant did not choose is not their feedback.

## Publish to their own desk

The destination is exactly one file: `_meta/preview-feedback.md` in the participant's own desk. It is not an iteration's `feedback.md` — that file is the PR/review feedback record for one iteration directory (see `directory-structure`) and must never receive preview feedback. Do not invent a second location, a shared file, or a root-level variant.

### Every entry carries a stable ID

An entry is named `pf-YYYYMMDD-<alias>-NN`: the date it was recorded, the participant's alias, and a two-digit sequence. Before writing, reread `_meta/preview-feedback.md` and take `NN` as the smallest two-digit number from `01` upward that no entry already uses for that same date and alias. Two things one person offers on the same day are therefore `pf-20260914-ari-01` and `pf-20260914-ari-02`, and each can be named on its own.

The ID goes in the entry's heading, and it never changes. A correction keeps it; a withdrawal keeps it. Do not renumber, reuse, or tidy IDs — not even the ID of a withdrawn entry — because the sequence records what was written, not what survives.

One entry is that heading, the participant's text as written, and an optional `Preview: <installed Desk version>` line recording the installed build (do not invent a version):

```markdown
## pf-20260914-ari-01 — 2026-09-14 — ari
Preview: 3.2.0-alpha.3

The agent asked for go at the right point, but repeated the same design choice three times.
```

### Amend only the entry you have read back

| Intent | Action |
| --- | --- |
| Record offered feedback | Reread the file, take the next free `NN` for that date and alias, and append one entry under its new ID, creating the file with an `# Preview feedback` heading if it does not exist |
| Read it back | Read that file; it is ordinary Markdown they own |
| Correct an entry | Reread, resolve the exact ID, confirm the text currently under it, then edit that entry in place and append `Corrected <YYYY-MM-DD>: <what changed>` inside it, keeping the heading and its ID |
| Withdraw an entry | Reread, resolve the exact ID, confirm the text currently under it, then replace that entry's text with `Withdrawn <YYYY-MM-DD> by <alias>: <their reason, if given>`, keeping the heading and its ID so the record of a withdrawal survives |

A correction or a withdrawal needs the exact entry ID **and** the participant's confirmation of the excerpt currently in the file. A date, a heading, "the last one", or the replacement wording alone does not identify an entry, and two entries from the same person on the same day are exactly the case where guessing amends the wrong attributed statement.

Refuse rather than guess. If the request carries no ID, if the ID matches nothing in the file, or if it matches more than one entry — a hand-edited file can contain duplicates — stop and show the participant the IDs that exist with their current excerpts. Do not amend the nearest match, do not renumber to fix a duplicate, and do not write a new entry to stand in for the one that was meant. If the text under the resolved ID is not what they expect, reconcile with them before writing: their own earlier correction, or someone else's edit, is not yours to overwrite silently.

Before any write, show the exact excerpt and the exact destination path, say who can read it and that a desk is a Git checkout whose history keeps what was pushed, and get visible confirmation for that pair. A request to keep a note private, an earlier general work mandate, or "we should share this later" does not authorize publication.

Use only the participant's own desk and its established contribution path, and keep the entry attributed to that participant. Withdrawal after publication is a tombstone, not history rewriting or an erasure promise: history, search artifacts, and copies may retain the original.

## Preserved private records are not a source

Some participants still hold private feedback captured by an earlier preview in a protected local store outside Git. That data stays where it is. Do not migrate, copy, summarize, index, or quote it into a desk, a report, or a message, and do not open its database directly. Only its owner decides whether any of it is ever offered — and if they offer it, they say the words again here, into their own `_meta/preview-feedback.md`.

## Explain the real boundary

A desk is a Git checkout that syncs to a remote, so anything written here is shared with everyone who can read that repository, and it enters the index and history. Say that before writing, not after.

The conversation and its provider retention are separate; nothing about this convention means the conversation never left the machine. Do not claim anonymity, physical erasure, or regulatory compliance.

For a requested minimal runtime diagnostic, use `desk_doctor` with `{"format":"preview"}`. That separate allowlisted package/process snapshot reads no feedback or task records and has no collector. Do not attach even that snapshot to a published entry without the participant's confirmation.
