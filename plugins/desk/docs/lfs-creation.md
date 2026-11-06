# Create an owned local Desk repository

The creator prepares local PDF/PNG storage in a directory it creates itself. It does not adopt an existing path, scaffold a desk, stage or commit files, create a remote, bind a runtime, install software or qualify binary publication. Its caller is fresh-create A4 after the operator's A3 choice; A5 binding stays with bootstrap. [Caller](../skills/first-run-bootstrap/SKILL.md), [implementation](../mcp/src/runtime/lfs-create.js).

From the loaded plugin's `mcp` directory:

```sh
node scripts/lfs.js create --repo "/existing/canonical/parent/absent-desk"
node scripts/lfs.js create --repo "/existing/canonical/parent/absent-desk" --apply --expect-plan "<plan_sha256>"
```

The first command emits a read-only plan. Apply recomputes it and refuses stale inputs before attempting non-recursive creation. An existing file, directory, repository or dangling symlink is refused; another creator winning the path receives no recovery claim from the losing caller. Exit `0` means a plan or `configured_local`, `1` means refused/partial, and `2` means invalid CLI arguments. None means binary sync is usable. [CLI](../mcp/scripts/lfs.js), [executable contracts](../../../tests/desk/mcp/__tests__/runtime/lfs_create.test.js).

## Custody and supported policy

`planLfsDesk({repo, env?, spawn?})` is read-only. `createLfsDesk({repo, expectedPlan, env?, spawn?})` is the explicit mutator. Both are synchronous and dependency-free. The selected root must be absent and absolute; its parent chain must already exist, be canonical and contain no symlink. Exact device/inode/mode checks use Desk's maintained file-identity primitive. Parent, root, Git directory and hook directory identities are rechecked around each mutating phase; generated hook and attribute bytes retain their own readback checks. The plan hash detects stale inputs. It does not supply custody, permission or a security fence against arbitrary writers. [Creator](../mcp/src/runtime/lfs-create.js), [exact identity primitive](../mcp/src/util/file-identity.js).

The bootstrap owner and helper are the sole cooperating writers until handoff. Other creators must respect non-recursive `mkdir`/`EEXIST`; they never adopt or clean up the winner's path. A changed identity or newer content stops the operation instead of being overwritten. This is the supported creation assumption, not a general lock for existing repository writers. [Competition and replacement fixtures](../../../tests/desk/mcp/__tests__/runtime/lfs_create.test.js).

The initial slice supports POSIX hosts with an already available Git LFS client, compatible default policy and a fresh `main` branch. Inherited repository/hook/template/storage redirection or conflicting filter/attribute policy is refused. Conditional configuration Git cannot qualify against an absent root is also refused, not guessed compatible. The helper writes no global/system configuration and never forces a hook overwrite or authors a hook composer. It does not disable signing or change author identity. [Preflight and local-phase guards](../mcp/src/runtime/lfs-create.js).

Configuration-source context must remain stable when Git checks run in the parent and native LFS setup runs in the new root. Relative global/system source filenames (`GIT_CONFIG_GLOBAL`, an enabled `GIT_CONFIG_SYSTEM`) and relative home/config directories (`HOME`, `XDG_CONFIG_HOME`) are refused before creation; the helper does not silently rebase, discard or replace them. The command-only configuration override (`GIT_CONFIG`) is unsupported even with an absolute filename because it can mask the effective policy used by other Git commands. Absolute global/system sources and their file-relative includes retain Git's actual semantics, including organization identity/signing policy; an explicitly disabled system source stays disabled. Command-line relative includes follow Git's refusal rather than being rewritten. [Context-drift and include fixtures](../../../tests/desk/mcp/__tests__/runtime/lfs_create.test.js).

Configured template sources are refused before directory creation. Git's native default initialization is preserved; copied configuration, active hooks, symlinks, staged state or seeded refs/objects are checked before LFS mutation. An unsupported native default can therefore leave a partial new root, but it does not license erasing that policy or proceeding with LFS setup. The helper does not replace templates with an empty template to bypass them. [Template and partial-root tests](../../../tests/desk/mcp/__tests__/runtime/lfs_create.test.js).

## Exact local effects

The plan exposes the standard local filter values, the attributes to write and the native hook set: `post-checkout`, `post-commit`, `post-merge`, `pre-push`. Filters use the installed client's local, skip-repository-hook configuration operation; its unforced updater supplies the standard hooks inside the owned Git directory. Custom or changed hooks are held. Current hook bytes and modes, local filter keys and effective attributes are read back before reporting `configured_local`. [Native Git LFS installation behavior](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-install.adoc), [native hook updater](https://github.com/git-lfs/git-lfs/blob/main/docs/man/git-lfs-update.adoc), [readback implementation](../mcp/src/runtime/lfs-create.js).

Only PDF and PNG patterns are enabled in this first qualified slice. Matching payloads under conventional `plugins/` paths stay ordinary Git bytes; other source/text rules are not broadly replaced. Future custom or root tooling packages require attribute review before staging. The creator cannot anticipate every future package root or claim every binary format is covered. Tests add synthetic PDF/PNG files only inside owned fixtures, then check actual indexed LFS pointers, SHA-256 cache-object bytes, unchanged originals and ordinary-Git plugin bytes. No probe file is added to a real desk. [First-object fixtures](../../../tests/desk/mcp/__tests__/runtime/lfs_create.test.js).

Each invocation has a 30-second command-launch budget and at most 10 seconds per owned subprocess, with hard termination on timeout. Filesystem scheduling is not a hard real-time guarantee. Timeout/failure effects remain explicit; they are not rolled back by deleting the root. [Runner and effects](../mcp/src/runtime/lfs-create.js).

| Result | Caller action |
| --- | --- |
| `plan` | Review the local changes and prerequisites; apply the same reviewed plan under the existing fresh-create choice. |
| `configured_local` | Continue the ordinary scaffold/initial contribution. The helper has not staged, committed, bound or published anything. |
| `refused` | Preserve the path and policy. Use the named read-only/prerequisite next step; no ordinary-Git fallback or automatic installer is supplied. |
| `partial` | The creating caller owns recovery responsibility. Retain the created root, recorded identity and exact attempted/verified effects; stop before binding or publication. Never delete newer content or retry creation over it. |

`effects` distinguishes not-attempted, attempted and verified phases. A partial result reports whether the selected path still matches the recorded identity; a lost identity is not a claim that the current path belongs to the creator. A losing creator that acquired no root receives no recovery ownership. Raw subprocess errors and inherited private policy values are not printed. Selected paths and inode receipts remain local diagnostic metadata, not upload-safe output. [Result contract](../mcp/src/runtime/lfs-create.js).

## Local configuration is not server usability

Every result keeps remote availability, authentication, service budget, upload and cold-consumer qualification as `not_checked`. No destination is created or probed. A repository's local client/hook/attribute configuration cannot prove that a selected server permits LFS access or has budget available. Keep binary publication pending until that separate authorized qualification succeeds; do not invent plan-independent quotas, send probes without scope, change billing/admin policy, bypass hooks or silently store the binary in ordinary Git. Local text/offline work and original bytes remain usable while those gates are unresolved. [Bootstrap completion boundary](../skills/first-run-bootstrap/SKILL.md), [local inspector's qualification limits](lfs-inspection.md).
