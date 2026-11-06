# Inspect local LFS evidence

This command is for agents diagnosing binary storage in an existing repository. It reports local observations without installing LFS, changing attributes or configuration, running hooks or content filters, fetching objects, or converting files. It does not establish that a desk is ready to publish or consume binaries. [Implementation](../mcp/src/runtime/lfs.js).

From the installed Desk plugin's `mcp` directory:

```sh
node scripts/lfs.js inspect --repo "/existing/repository"
```

Omit `--repo` to inspect the current directory's Git repository. The command accepts no setup, repair or conversion action. It prints one JSON object. Exit `0` means an inspection report was produced, including a report with limitations or defects; exit `1` means the repository or Git metadata could not be inspected; exit `2` means invalid arguments. Exit `0` never means storage is ready. [CLI](../mcp/scripts/lfs.js).

## API and evidence scope

`inspectLfs({ repo, env?, spawn? })` is synchronous and dependency-free. `repo` defaults to the current directory only when omitted; empty, null, inaccessible and non-directory inputs do not fall back. `env` supplies the calling environment; `spawn` is the process seam used by tests. The result uses `schema_version: 1` and `action: "inspect"`. [API](../mcp/src/runtime/lfs.js), [executable contracts](../../../tests/desk/mcp/__tests__/runtime/lfs.test.js).

| Field | Contract |
| --- | --- |
| `state` | `inspected` means the scoped observations finished; `limited` names incomplete evidence in `findings`; `not_git` and `unavailable` mean inspection could not proceed. None means healthy or ready. |
| `repository` | Reports `kind` (`context`, `package`, `unknown`), `context` (`personal`, `shared`, `unknown`), origin presence, partial/sparse configuration and discovered package roots. It does not print remote URLs or account identities. |
| `tool` | Runs only `git-lfs version`, directly rather than through a Git alias. Reports `available` with a parsed version, `missing`, `unavailable` or `not_checked`. Availability is not compatibility or transfer proof. |
| `configuration` | Observes effective Git LFS filter definitions, skip-smudge behavior, custom Git LFS storage configuration and the effective Git hooks location. Definitions outside the recognized standard form are `custom_or_incomplete`, not overwritten. Hook existence is metadata only; `integration` is always `not_checked`. External or symlinked hook paths are not followed. Endpoint, `.lfsconfig` and credential validity are not qualified. |
| `files` | Index-relative paths with effective `filter`, `diff`, `merge` and `text` attributes, tracking/format observations, proposed review action, and separate local-object/materialization states. Custom attribute values are reduced to `custom`, not printed. |
| `limits` | Reports the fixed inspection budgets. They are resource bounds, not production binary-size policy. |
| `qualification` | `remote_publication`, `network_auth` and `installed_payload` are always `not_checked`. |

Inventory comes from the current index, not all history or every working-tree file. Staged entries can therefore differ from HEAD. Untracked files are not opened. Tracked ignored files and sensitive-path candidates are reported as skipped before indexed-blob reads, working-file reads or per-path attribute queries; non-regular or unmerged entries are also skipped. Sensitive-path checks reuse Desk's maintained exclusion semantics, including `_secrets`, with additional credential-file precautions. This is a precaution, not a secret detector. Other file prefixes and small indexed blobs may be read, but contents, filter commands, hook contents, configuration values and raw subprocess errors are never included in the report. Paths and object identifiers remain local diagnostic metadata, not an upload-safe artifact. [Inspection and path guards](../mcp/src/runtime/lfs.js), [maintained exclusions](../mcp/src/indexer/exclusions.js).

Git commands disable fsmonitor, optional locks and lazy fetch, deny all transport protocols, and remove inherited repository/index/object-directory selectors. Attribute lookup uses working-tree/index policy: inherited `GIT_ATTR_SOURCE` is removed and `attr.tree` is cleared for each Git call, so another commit cannot supply the attributes. Other Git attribute sources, including nested and `info/attributes` overrides, remain in effect. The inspector does not call `status`, `diff`, `fsck`, `fetch`, `pull`, a content filter or a hook. It leaves index, refs, configuration, files and hook policy unchanged. Errors are reported as bounded codes rather than raw stderr, which can contain private remote URLs. These guarantees are checked with before/after hashes of synthetic working trees and their Git metadata. [Safety fixtures](../../../tests/desk/mcp/__tests__/runtime/lfs.test.js).

## Binary and package policy

The maintained `desk-context-binaries-v1` extension list covers common Office/OpenDocument files, PDFs, raster images, archives and audio/video, regardless of size. The exact list is in the result's `policy.extensions`. It is an engineering default for context repositories, not a universal binary detector. An unlisted file with a NUL in the inspected prefix is `unknown_binary`; other files are only `not_identified_as_binary`, not certified text. The inspector never changes ignore rules or decides that a file is safe to commit. [Policy](../mcp/src/runtime/lfs.js).

`track_exact_path` is a proposal only for an ordinary-Git binary in a recognized context repository. Unknown repository scope requires `review_repository_scope`; an unknown binary needs `review_exact_path`; custom, unreadable or explicitly disabled filter policy needs `review_existing_policy`. Missing, unsafe or unreadable working files require `review_worktree_state`. An incomplete package inventory requires `review_incomplete_inventory` instead of a tracking proposal. These labels authorize no write.

Package payloads get `package_exempt`, not a proposal to store them in context LFS. Discovery includes the conventional `plugins/` tree, manifest-bearing roots (`plugin.json`, `.claude-plugin/plugin.json`, `agency.json`), local marketplace source paths and `_meta/crew.json` local tooling paths. A package manifest at the repository root exempts the whole repository. An external tooling repository is not scanned or cloned. Invalid, ignored, unavailable or oversized declarations leave scope incomplete. This is local package-root discovery, not dependency-closure or installed-payload verification. [Package discovery](../mcp/src/runtime/lfs.js).

## Read local objects without mistaking pointers for files

The inspector recognizes the canonical three-line SHA-256 pointer form. A recognized pointer records expected object length and digest. A malformed pointer using that version header is `invalid_pointer`; unsupported pointer forms are not a promise of LFS compatibility. [Pointer parsing](../mcp/src/runtime/lfs.js), [Git LFS pointer format](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage#pointer-file-format).

`materialization: "pointer"` means the working file still contains the indexed pointer. `verified` means the local file's length and SHA-256 match that pointer; `mismatch` means they do not. Local cache objects are checked separately in the repository's standard shared Git LFS object directory. A cache object can be present while the working file remains a pointer, or the working file can be correct while the cache object is missing. Custom `lfs.storage` is reported as `not_checked_custom_storage`; the inspector never follows that configured path. Hook and cache checks validate the directory root and its entire parent chain as well as the path below it. A symlinked metadata root or ancestor is `unsafe_path`, not a verified cache or hook. Missing, unsafe, unreadable, changing or over-budget paths retain those explicit states. No corrupt object is relocated. [Local-byte inspection](../mcp/src/runtime/lfs.js).

Inspection stops at 512 index entries, reads at most 4 KiB per prefix, hashes at most 16 MiB per file, and spends at most 64 MiB on inspected content. Git output is capped at 2 MiB per command. A 10-second work budget limits command launches and file reads. Both synchronous subprocess paths use a timeout with `SIGKILL`, not a catchable termination signal; the POSIX regression runs real children that ignore `SIGTERM`. This bounds owned direct-child execution, not filesystem scheduling or arbitrary descendant processes; native Windows termination is not qualified by the POSIX test. A skipped hash is `not_checked_limit`, never `verified`. Missing attributes or blobs in partial/sparse repositories are not fetched. Observations are bounded reads, not an atomic snapshot against concurrent writers. [Budgets and observations](../mcp/src/runtime/lfs.js), [termination regressions](../../../tests/desk/mcp/__tests__/runtime/lfs.test.js).

## What remains unqualified

Doctor can request this inspector explicitly with `{"storage":"inspect"}` in an owned worker; default and preview calls do not inspect storage. Fresh bootstrap has a separate owned-new-root creator for local PDF/PNG configuration; it does not adopt or convert an existing repository, hydrate clones or qualify a server. Existing-repository conversion remains a separately authorized forward-only contribution, not an automatic startup migration. Local verification does not prove remote publication, network authentication or usable installed plugin bytes. [Doctor observation contract](lfs-doctor.md), [new-root creator](lfs-creation.md).

Three existing producer/consumer edges still need owner-integrated work and acceptance:

- Crew template copying currently decodes every file as UTF-8 before substitution; binary-safe copying and byte verification must precede claiming complete binary templates. [Current join implementation](../mcp/src/crew/workspace.js).
- Delivery and team lessons skip LFS smudging. Successful text delivery is not proof that a binary consumer can materialize objects. [Delivery](../mcp/src/runtime/deliver.js), [team lessons](../mcp/src/tools/lesson-team.js).
- Package acquisition must prove real payload bytes, including archives and images, at root and custom tooling paths. GitHub source archives can include or omit LFS objects by repository setting; pointer presence cannot qualify a plugin install. [Crew install locators](../mcp/src/crew/workspace.js), [runtime pack contract](../mcp/artifacts/runtime-deps/README.md), [GitHub archive behavior](https://docs.github.com/en/repositories/working-with-files/managing-large-files/about-git-large-file-storage).
