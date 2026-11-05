# Archive integrity

The default fresh archive operation on macOS/Linux can preserve relative
Markdown links across a move in a non-Git desk. It observes files and directory
referents in the effective person's root before writing, then composes outbound
and inbound links, track rows and card updates against one original/final map.
Git, Windows and custom transports retain their existing archive behavior.
An original `task.md` symlink also retains the existing legacy route, after
metadata-only relocation checks and before reading card contents. A stable
symlink is not admitted into the aggregate map; a symlink that would change
referent still refuses before the move.

The operation refuses ambiguous, missing, aliased or out-of-scope targets.
External `.git` and `node_modules` directories are opaque storage boundaries:
their type, identity, mode and parent membership are checked, but their contents
are not traversed. Such storage inside the moved source is unsupported and
refuses before any effect. Another person's tree is not read or rewritten.

The original card observation binds its descriptor, name, bytes, mode and
version before parsing completion evidence. Refresh and preflight reads renew
that same observation before reading, so a replacement symlink, oversized file
or newly appeared card cannot inherit old completion evidence.

The first admitted effect creates `.desk-archive-operation.json` exclusively.
This marker is a **negative signal**, not a completion record or retry grant.
Any type at the selected source or destination blocks a later invocation on
every archive route. An interrupted operation retains its files and marker;
repeating `task_archive` cannot adopt the current bytes or report
`already_archived` merely because the destination exists.

Each replacement uses an exclusive read/write, no-follow stage with bounded
positional writes and independent full-EOF reads. The named rename source and
installed file must match the originally owned stage inode. Original target
bytes, descriptor and parent are renewed after stage IO and before replacement.
Equal bytes in a foreign inode are not ownership. Fresh archive parents join
the existing created-directory registry only after identity checks.

The original marker is retired only after Final checks and required descriptor
closure. Confirmed unlink and absence immediately retain the known
`final_complete` filesystem phase, even if a later observation fails. Unknown
unlink, partial IO or descriptor closure stays pending; there is no replay,
foreign cleanup or age-based clearing.

Factory terminal work is separately observed at its existing top-level
handoff. A known marker at the last gate prevents a new call. An already
accepted call may still write, repair or clean up its private state after a
racing marker or deadline. Its result/error and post-await uncertainty are
recorded separately; no further helper is dispatched and the archive returns
pending without pretending those internal effects were canceled.

## Bounds and qualifications

The new operation has an original 30-second mutation deadline and 40-second
descriptor/evidence settlement cutoff from handler entry. Successful card
reads recheck that original deadline after closing their descriptor before
starting any peer or PR refresh. Neither clock renews or forcibly cancels
in-flight filesystem or Factory work.

Inventory is limited to 512 directories, 4096 entries, depth 16, 256 Markdown
documents, 1 MiB per document, 16 MiB Markdown bytes and 64 MiB admitted
companion/target bytes. Changes are limited to 64 owners, 8 MiB and 4096
reference records. File IO uses at most 64 KiB chunks; owned directory readers
use a one-entry buffer and check limits before retaining names for sorting.

These checks provide optimistic currentness, not kernel compare-and-swap or
exclusion of nonparticipating editors. The final check-to-syscall and
mkdir-to-first-observation races remain. No native Git/Windows aggregate
custody, persistent trusted Final retry or installed recovery guarantee is
implied. The real non-Git and source-boundary controls are in
[archive_link_aggregate.test.js](../../../../tests/desk/mcp/__tests__/tools/archive_link_aggregate.test.js).
POSIX-provider cases run only on macOS/Linux. Portable marker, legacy,
frontmatter, directory-registry and read-only planner controls stay active on
Windows, with subprocess dispatch fenced before production imports. These
controls do not activate or qualify a Windows aggregate provider.
