# Retired private feedback storage

The V2 Desk tool surface has **no qualitative feedback tool**. `desk_feedback` was retired: it is not advertised in `tools/list`, and a call to that name gets the ordinary unknown-tool response. Preview feedback a participant chooses to offer is written as attributed Markdown in their own desk at `_meta/preview-feedback.md`, deliberately not an iteration's `feedback.md`, which is the PR-review record for one iteration directory. The `preview-feedback` skill owns the exact path, entry, correction and tombstone format.

## What is left on disk

Nothing was migrated, exported, indexed or deleted. Records a participant captured before the retirement stay where they were, at `$XDG_STATE_HOME/ouroboros-skills/desk/feedback/<partition>/feedback.sqlite` (`~/.local/state/...` when `XDG_STATE_HOME` is unset or blank), under the owner-only protections they were written with. This build ships no code that reads, writes or deletes them: no tool, no command, no reader. The files remain the participant's own on their own machine. Treat them as preserved archival data, not as a surface a participant can be told to inspect or edit through the product. Restoring owner access would need a separately proposed and explicitly approved reader.

A call to `desk_feedback` is refused before any feedback storage is opened or created, and a binding with no store does not gain one from the refusal. The server dispatch tests check that preserved bytes are unchanged after such a call.

## What the retirement does not do

Removing the code did not delete anything from a participant's machine. The records are not encrypted, do not sync across devices and rely on operating-system access controls on one machine. They were never copied into Git, into the search index or into any report. Deleting them is the participant's own act on their own disk.
