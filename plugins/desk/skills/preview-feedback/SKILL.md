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

| Intent | Action |
| --- | --- |
| Record offered feedback | Append one dated, attributed entry to `_meta/preview-feedback.md`, creating the file with an `# Preview feedback` heading if it does not exist |
| Read it back | Read that file; it is ordinary Markdown they own |
| Correct an entry | Edit that entry in place and note the correction under it, so the change is visible rather than silent |
| Withdraw an entry | Replace the entry text with a participant-authored tombstone line in the same entry, keeping its heading |

One entry is a `## <YYYY-MM-DD> — <alias>` heading, the participant's text as written, and an optional `Preview: <installed Desk version>` line. A correction appends `Corrected <YYYY-MM-DD>: <what changed>` inside that entry. A tombstone replaces the text with `Withdrawn <YYYY-MM-DD> by <alias>: <their reason, if given>` and leaves the heading in place so the record of a withdrawal survives.

Before any write, show the exact excerpt and the exact destination path, say who can read it and that a desk is a Git checkout whose history keeps what was pushed, and get visible confirmation for that pair. A request to keep a note private, an earlier general work mandate, or "we should share this later" does not authorize publication.

Use only the participant's own desk and its established contribution path, and keep the entry attributed to that participant. Withdrawal after publication is a tombstone, not history rewriting or an erasure promise: history, search artifacts, and copies may retain the original.

## Preserved private records are not a source

Some participants still hold private feedback captured by an earlier preview in a protected local store outside Git. That data stays where it is. Do not migrate, copy, summarize, index, or quote it into a desk, a report, or a message, and do not open its database directly. Only its owner decides whether any of it is ever offered — and if they offer it, they say the words again here, into their own `_meta/preview-feedback.md`.

## Explain the real boundary

A desk is a Git checkout that syncs to a remote, so anything written here is shared with everyone who can read that repository, and it enters the index and history. Say that before writing, not after.

The conversation and its provider retention are separate; nothing about this convention means the conversation never left the machine. Do not claim anonymity, physical erasure, or regulatory compliance.

For a requested minimal runtime diagnostic, use `desk_doctor` with `{"format":"preview"}`. That separate allowlisted package/process snapshot reads no feedback or task records and has no collector. Do not attach even that snapshot to a published entry without the participant's confirmation.
