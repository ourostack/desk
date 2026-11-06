# Inert contribution-control data contracts

These are pure, unwired schemas and supplemental contextual checks. They do not read state, query GitHub, verify a live actor, register an authority adapter or authorize a publication/deletion. A successful result says only that the supplied data is coherent. Trusted workflow, canonical pipeline, store activation, capture/reader and CLI integration are separate work.

## Inert input snapshots

Context/set entry points inspect one JSON-compatible data graph before materializing a private snapshot. Own descriptors are read without invoking getters; custom prototypes/inherited hooks, proxies, accessors, functions, symbols, cyclic graphs and non-data object references refuse with a fixed code. Ordinary plain/null-prototype objects, dense arrays and Buffers remain supported. No `JSON.stringify`, `structuredClone`, iterator or `toJSON` rejection probe is applied to the original graph.

Preflight bounds are 16 levels, 10,000 visited nodes, 64 object properties, 500 array entries and 24 MiB of aggregate key/string/unique byte-view content. These do not raise the individual public-record, capture/context or 16 MiB change-set caps. Bounds/descriptors are checked before any Buffer/array/object snapshot is materialized; an oversized graph produces no Buffer copies.

The descriptor plan also checks each recognized envelope/withdrawal/capture/context byte cap and the existing aggregate 16 MiB change-set budget before materialization. Shared byte references are copied once but counted separately where the operational change-set budget counts them.

Buffers are copied by their native byte view, not receiver conversion/length methods. Proxied/custom-prototype/shared-backed Buffers and own byte-conversion hooks are refused. Extra non-byte properties are not copied or invoked. Wire JSON is decoded from captured bytes, parsed/validated as one value and reused; later checks never reread a caller accessor or reinterpret a second value. Invalid UTF-8 and excessive wire serialization depth refuse without exposing receiver exceptions.

A Buffer must also have a genuine native Uint8Array brand; a prototype-only impostor refuses before native backing getters. A detached or otherwise unusable native view refuses as `non_data_input`, including when its reported byte length is zero. Only the native byte-copy operation's `TypeError` is normalized at that boundary; allocation errors and unrelated programming failures still propagate. Attached empty Buffers remain valid byte inputs and fail the ordinary JSON check, not the native-view check. No caller buffer is transferred or detached by validation.

This is data/byte snapshot discipline, not a defense against a compromised JavaScript runtime or a live authority adapter.

## Public bytes

`validateContributionBytes(bytes)` accepts only canonical JSON (optional final newline), at most 4,096 UTF-8 bytes:

```json
{"schema":"desk.factory.contribution/1","protocol":1,"sequence":1,"policy_generation":0}
```

`sequence` starts at 1; `policy_generation` starts at 0. Both are safe integers; no wraparound or decrease. The envelope path is `contributions/<16-lowercase-hex intake nonce>.json`.

`validateWithdrawalBytes(bytes)` uses the same canonical/4,096-byte rule:

```json
{"schema":"desk.factory.withdrawal/1","session":{"host":"copilot-cli","id":"12345678-1234-4123-8123-123456789abc"},"previous":{"path":"facts/copilot-cli-12345678-1234-4123-8123-123456789abc.json","blob":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"reason":"proof"}
```

The identifier above is synthetic. In a real withdrawal, it must already be public. The path must match that exact host/alias and the blob is its prior public Git blob SHA. No prose, native identity, account, desk path, timestamp, private evidence hash or extra field is accepted. Its path is the corresponding `withdrawals/<host>-<alias>.json`. This schema cannot establish that an alias was already public.

All errors contain fixed codes/schema paths only, never rejected values or caller-supplied path strings. Duplicate keys, noncanonical bytes, unknown fields and malformed types refuse.

## Supplied contextual data

`checkContributionIntake(input)` accepts these fields only:

- `capability`: `{state:"supported",value:{contribution_control:1}}`, or explicit `{state:"absent"}`/`{state:"unknown"}`. Absent is `contribution_unsupported`, unknown is unavailable; neither is an activated fallback.
- `baseEnvelope`: `{state:"present",base,path,bytes}` or `{state:"absent",base}`. `unknown` is not absence. `base` is a supplied Git commit SHA, not read from the machine.
- `proposedEnvelope`: `{path,bytes}` or `null`. A data-changing intake must actually add/modify that same envelope in `changes`; inheriting it from base is insufficient.
- `currentWithdrawals`: `{state:"complete",base,records:[{path,bytes}]}`. Unknown, unreadable, truncated, malformed or duplicate records refuse rather than become an empty set.
- `changes`: at most 500 distinct safe repository-relative paths, each `{path,status,bytes?,previousBlob?}` with `status` added/modified/removed. Byte payloads across the supplied change set are capped at 16 MiB. No renames or caller-provided executable adapter is accepted.
- `verifiedLineage`: `{state:"verified",intake,branch,base,actor,currentPublic:{state:"complete",records:[{path,blob,actor}]}}`. This is normalized **data supplied by a future trusted adapter**, not proof generated by this module. The branch must be `intake/<intake>`, every supplied base must agree, and public rows must be unambiguous. Missing/unknown/foreign provenance refuses withdrawal even if a separate caller claims to be a maintainer.
- Optional `maintenance` boolean is descriptive only. Actual data paths determine whether the envelope gate applies; mixed code/data cannot bypass it.

Current withdrawal and public-lineage lists each have a 500-record bound. A complete empty list is known absence, while a missing/incomplete list is unknown. A caller must not truncate to fit the bound.

For data changes, sequence is exactly base sequence + 1 (or 1 for confirmed first use); policy generation cannot decrease. Maximum-safe sequence cannot advance. Envelope path, actual changed envelope and supplied intake must agree. Accepted tombstones are immutable; new tombstones require qualified supplied current public path/blob/actor and same-intake matching facts removal. An unpublished/queued-only target has no such public row, so no public tombstone is admitted.

An envelope alone, or only an empty capture with no supplied already-public capture record, cannot bootstrap a new public nonce. Correcting an already-public owned empty capture remains possible. Supported facts/labels/context/capture byte validators and path identities are reused; the future capture/2 protocol is not implemented here.

Any ordinary removal also needs an exact supplied current public blob and matching actor. Other canonical public-data checks, source correlations, semantic privacy and actual live provenance remain necessary; this pure check is not a replacement for the existing intake gate.

Facts, labels and context citing a withdrawn alias cannot be reintroduced, including under another supported host. Unaffected legitimate data remains eligible for normal validation. A code-only maintenance verdict is not a permission grant.

`withdrawnPublicSessions(input)` accepts the complete withdrawal-list wrapper and returns `{ok,errors,sessions}`. `sessions` is a syntactically validated `Set` of aliases from the supplied accepted-public records, including an empty set for complete empty input, and is `null` on every failure—never a partial prefix or an empty success for unknown input. The caller must independently establish that these are the actual accepted public base records.

## Private authority/index prerequisite

The private source prerequisite is separate from the pure public-byte verdicts. It does not register a producer adapter, activate a store, create a qualification witness or secret, or withdraw public records. Existing producer behavior and the historical unregistered policy's single-file APIs remain unchanged. A supplied flag or successful pure verdict cannot select the trusted branch.

`contribution-storage.js` observes an existing protected Factory root without creation, protection repair or locks. Closed roles use owner-only, single-link, no-follow held-FD reads with a sentinel, exact byte counts and final leaf/parent correlation. A role set has at most 32 files and a 32 MiB allocation budget. Owner policy/index/receipt files are at most 1 MiB, prepared transactions 4 MiB, private requests 16 KiB and the existing secret exactly 32 bytes. Missing and unsafe state are distinct from an empty policy; no corrupt-file rename, default JSON, secret rotation or arbitrary path reader is used.

`contribution-authority.js` requires the actual protected marker, matching derivation receipt and valid local facts to agree on the requested owner, host/session and store. It reads the existing consent/intake nonce and secret, then verifies the existing sealed qualification witness against current source fingerprints. The resulting authority has an internal identity that a JSON copy cannot reproduce. Each index admission rechecks the underlying authority; a genuine failure cannot fall back to unchecked inert storage. Marker-only or missing person/source lineage is insufficient. Delivery-only ownership without that chain is currently unavailable, not inferred from a public filename.

Qualification witnesses are read from the existing private intake folder; they may bind the exact owner or the machine's store/intake contract. Both have closed schemas and a machine-secret seal. Their presence is not proof that this source unit qualified a real store or platform: synthetic fixtures provision their own witnesses, while actual qualification, migration and native support remain separate gates.

The private intake folder is `contribution-control/<store-slug>/<existing-intake-nonce>/` under the protected Factory root. It contains `index.json`, `transaction.json`, qualification and compact receipts. The index binds owner activation/ledger byte hashes and owner generations to a distinct monotonic intake generation and index revision. A new effective owner intent advances that owner's generation and the intake generation once; journal-only updates advance index revision without changing effective generations. Taking the maximum owner generation would miss another owner's first exclusion.

An authorized image transaction uses the existing physical lock order: `flush.lock`, the target derivation lock, then `locks/contribution-policy.lock`. It prepares sealed predecessor/pending/after images before any replacement, publishes a pending barrier, writes the owner pair, then publishes the final coherent index and receipt. Missing ancestors are not created by this writer. Source and old audit bytes remain; cleanup does not sweep unrelated files.

Read-only status/plan never complete an interrupted transaction. A write-admitted retry can forward-complete only authenticated staged images whose current bytes match the exact predecessor, pending barrier or after-image. A final-index response loss records the same receipt without rewriting owner images or advancing generation again. Missing required evidence, foreign bytes, changed consent/qualification or lost seals hold the operation; they do not manufacture legacy state. This local recovery grants no remote replay or public deletion.

The CLI accepts only `contribution-plan --request <private-file>`, `contribution-status --request <private-file>` and `contribution-exclude --request <private-file> --expected-plan <opaque-token>`. The closed request carries the private target in a protected file, not an identity flag. Diagnostics return fixed codes, counts and opaque operation tokens, not request contents. Explicit exclusion persists private intent only; ordinary contribution/withdrawal integration remains unwired.

Only synthetic Linux-mode source-unit fixtures are qualified in this generation. Unsupported default protection reports `platform_unqualified` without probing or repairing it. Maintained CLI/flush compatibility, Darwin/Windows native protection, installed consumers, actual store qualification/activation and end-to-end contribution control remain open checks. The new CLI-negative and extracted-lock tests do not replace those checks.
