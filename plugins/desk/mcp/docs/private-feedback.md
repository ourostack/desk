# Private feedback storage (retained, not a tool)

The V2 Desk tool surface has **no qualitative feedback tool**. `desk_feedback` was retired: it is not advertised in `tools/list`, and a call to that name gets the ordinary unknown-tool response. Preview feedback a participant chooses to offer is written as attributed Markdown in their own desk — a `feedback.md` convention, not an MCP database.

What did *not* happen is just as important: nothing was migrated, exported, indexed, or deleted. Records a participant already captured stay exactly where they were, under the same protections, and the storage primitive described below is retained rather than removed. Be precise about what that does and does not give the owner: the files remain theirs on their own machine, but this build ships **no route to them** — no tool, no command, no reader. Treat them as preserved archival data, not as a live surface a participant can be told to inspect or edit through the product.

## What this store is not

- **Not telemetry.** The store has no background collector or network operation and records no flow, effort, duration, cost, or performance figure. Nothing writes to it on its own. Feedback typed into or read back through an agent remains part of the host/model conversation and follows that system's retention rules.
- **Not Git-durable friction.** Friction notes (`friction_add`) are written into the desk workspace, which is a Git checkout that syncs to a remote. Private records deliberately never land there.
- **Not part of the search index.** The desk index (`.state/desk-index.sqlite`) is a rebuildable derivative that gets dropped and rebuilt, and it feeds `desk_search`, `desk_recall`, and embeddings. This store is separate and is never indexed, embedded, or snapshotted.
- **Not a replacement for the Markdown convention.** Offered feedback belongs in the participant's own desk, attributed to them. This store is preserved private data, not the place new offered feedback is published.

## Storage and permission contract

| Property | Value |
| --- | --- |
| Location | `$XDG_STATE_HOME/ouroboros-skills/desk/feedback/<partition>/feedback.sqlite`, defaulting to `~/.local/state/...` when `XDG_STATE_HOME` is unset or blank |
| Partition | First 32 hex characters of SHA-256 over the JSON object containing resolved `desk_root` and `person`, derived from the session binding |
| POSIX directory modes | `0700` on every directory the store owns; a loosened directory is tightened on the next open |
| POSIX file mode | `0600` on the SQLite file |
| macOS extended ACLs | Removed from the store-owned directories and DB, with native read-back before SQLite opens; the enclosing state home is not reconfigured |
| Windows DACLs | Protected from inherited rules, with exactly one Allow FullControl rule for the current user SID; directory rules inherit to children; native ownership and rules are read back |
| Engine | `better-sqlite3` (the dependency the package already carries), with `journal_mode = DELETE` and `secure_delete = ON` |

The partition is derived, never supplied. There is no path, alias, database, or namespace field anywhere in this surface, so one binding reads and writes exactly one partition — its own — and there is no cross-desk or cross-person browsing. With the tool retired, no MCP caller reaches it at all.

The store refuses to open, rather than degrading quietly, when:

- the resolved store path would fall inside the desk workspace;
- the state home or any directory above it contains a `.git` entry (point `XDG_STATE_HOME` at a directory that is not under version control);
- any directory in the store path is a symlink or is not a directory;
- the SQLite file is a symlink, is not a database, or cannot be opened;
- a path cannot be inspected because of permissions.

Those refusal messages still begin with the `desk_feedback:` label. The label is how this data has always identified itself in protection errors, and it is preserved byte-for-byte so existing records and existing messages stay recognizable; it does not mean a tool by that name exists.

### Platform boundary

Linux uses owner-only POSIX modes. On macOS, extended ACL grants can survive `chmod 0700/0600`, so the store also clears ACLs on its own paths with the system `chmod -N` and verifies the result through the native ACL listing. It leaves the enclosing state home unchanged.

Windows uses the built-in Windows PowerShell/.NET ACL provider under `%SystemRoot%`, not a PATH-selected replacement or a POSIX-mode claim. The fixed program receives paths as UTF-8 JSON data. It rejects reparse points and existing objects owned by another identity; a newly created object with default Administrators-group ownership may be assigned to its actual creator SID. It applies and reads back the protected owner-only DACL before SQLite opens.

An unavailable provider is rejected before state creation. Any failed or incomplete protection stops the operation without writing anything or falling back to an unprotected store. There is no policy bypass, elevation, dependency installation, or host-permission configuration change. A protection failure here is scoped to this store; the Desk tools — including the private work ledger, which keeps its own separate namespace through the same protected-storage primitive — are unaffected.

Adapter tests and repacked Windows binaries do not qualify NTFS behavior. The native Windows CI job exercises real directory/file DACLs, Unicode paths, junction rejection, foreign-owner rejection and new-object owner reassignment, the private store's own record/reopen/correct/delete path, the work ledger's namespace, and the actual offline source mirror. Native macOS tests separately cover inherited and later-added ACL grants.

## Preserved records

An entry is `{ entry_id, preview_version, text, task_ref, revision, captured_at, updated_at }`. `preview_version` is the installed Desk plugin version, not the independently versioned MCP component. It identifies the declared preview release; it is not an independently measured fingerprint of every active plugin.

The retained module (`src/feedback/store.js`) still implements record, page, correct and remove, and those operations remain exercised — by the storage suite and by the offline source-mirror witness — so the format stays operable and the data does not rot behind untested code. No shipped surface calls it. Restoring owner access would require a separately proposed, explicitly approved reader; do not add one incidentally, and do not tell a participant an operation is available that this build does not offer. The semantics, if such a reader is ever approved, are unchanged: pages are live reads under one SQLite transaction rather than a frozen export, `correct` requires the revision the caller last read so a stale correction fails with the current revision instead of overwriting an edit it never saw, and a `correct` or `remove` against an unknown `entry_id` is an error rather than a quiet success.

## What deletion does and does not mean

Removal drops the row. There is no soft-delete column, no tombstone, and no retained copy of the text: with `secure_delete = ON` SQLite overwrites the freed pages, and `journal_mode = DELETE` keeps the words out of a write-ahead sidecar. After a removal, reopening the store does not return the text.

That boundary ends at this file. Deletion here does **not** reach:

- backups, snapshots, or disk images taken by the operating system or any backup tool;
- copies the participant already shared — a message, a pasted quotation, or a summary already written to a desk;
- the conversation transcript the feedback was typed into.

The store is not encrypted and does not sync across devices. It uses operating-system access controls on one machine. It does not isolate agents running as the same operating-system user or prevent privileged administrators from accessing the file. Those limits must not be described as anonymity or regulatory compliance.

## Sharing is not a hidden action

Nothing here shares, exports, publishes, or syncs, and no branch of any operation writes outside the private store. Retirement changed the tool surface, not that boundary: preserved records were not copied into Git, into the index, or into any report.

Publishing feedback is therefore a separate, visible step the participant takes: the agent shows the exact excerpt and the exact destination, the participant confirms, and only then is the attributed text written to that participant's own desk as Markdown. Because a desk is a Git checkout, withdrawal after that point is a tombstone, not an erasure — history keeps what was pushed. Say that plainly when offering to publish.
