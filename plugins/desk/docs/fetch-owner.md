# Bounded Git graph fetch ownership

`runFetchOwner(options)` reserves a private Git-common-directory lane and fetches one captured HTTP branch into operation-owned candidate/verified refs. `inspectFetchOwner(options)` revalidates the current route, advertised object ID and complete Git object closure; it can perform network reads and acquire that lane. It is **not** a status/preview fast path. `cancelFetchOwner({ root, operationId, env })` requests cancellation of the exact current operation/token; its pending response is not proof of subprocess closure. [Implementation](../mcp/src/runtime/fetch-owner.js), [real-Git tests](../../../tests/desk/mcp/__tests__/runtime/fetch_owner.test.js).

## Qualified boundary

This unit is a macOS/owned-HTTP prototype with no startup, delivery-worker or source-application caller. Unsupported platforms, credential/repository policy and reference-transaction hooks are explicit gates, not permission to disable policy. Existing delivery, executable pre-push/LFS and split-route restrictions remain separate. Every result carries `sourceApplied: false` and `lfsReady: false`: a verified graph can contain LFS pointers and does not establish materialization, upload, checkout, plugin payload or binary-consumer readiness.

The public operations accept `root`, `env` and finite `timeoutMs`, `progressTimeoutMs`, `maxFileBytes`; start/inspection also accept an abort `signal` and `onProgress`. Defaults are a 60,000 ms whole job, progress bounded by the smaller of 10,000 ms and the job, and an 8 MiB per-file storage ceiling. Allowed ranges are 2,000–120,000 ms whole job, 1,000 ms through whole-job limit for progress, and 1–32 MiB per file. Progress never extends the whole deadline. Local bootstrap, transfer, remote readback, publication and closure consume the same budget.

The only shared runner change is optional finite `timeoutMs`/`signal` forwarding in `state-branch.runGit`, preserving its 15,000 ms default and all branch policy. Invalid timeout/signal/runner inputs fail before dispatch instead of silently restoring the default.

Bootstrap, cancellation lookup and transfer use the same maintained trusted Git executable; its directory leads the subprocess search path so nested Git commands do not re-enter an arbitrary PATH wrapper. This does not qualify custom Git wrappers or authentication providers.

The controller independently bounds helper startup and pending requests; it does not rely on an unresponsive helper consuming IPC or starting its own timer. Expiry rejects pending work and terminates/escalates the exact owned helper. A killed helper without matching closure evidence retains unknown custody.

## Context and receipts

Before any network read, the owner derives the canonical root/common directory, current branch and upstream ref/endpoint, effective configuration and activation identity. A saved activation root must canonically match the operation root. Freshness checks compare local identity **before** reading the captured remote; they never contact a newly substituted endpoint to see whether it is acceptable.

Freshness derives the actual current canonical root, common directory and worktree Git directory again, including directory identity, rather than hashing the captured common path as if it were current. Network/ref operations validate that binding and target the original derived Git/common directories. A `.git` rebind with otherwise identical config cannot borrow the original lease to act in another repository.

The advertised object ID is pinned per operation. A descendant advance or unrelated replacement preserves the fetched candidate and records the observed new object ID, but prevents current-generation readiness. Reserved candidate/verified ref names in a blocked outcome are not proof those refs were published or qualified. Completed receipt reuse rechecks the verified ref, full object closure and actual remote; a matching private record alone is not object proof. No rewrite map, surviving backup or source-application authority is inferred.

Finalization may impose blocked/retained/unverified status, but it does not discard captured pinned/observed OIDs or reserved ref names. Those facts remain in the returned result even when a receipt cannot be written or a closure witness is unknown. Missing fields are filled only from actually captured record data; neither publication nor closure is inferred from a retained name.

Private records are bounded to 64 KiB, four retained operation directories and the existing metadata-entry cap. Pack-file ceiling observation visits at most 128 directory entries; unsupported observation fails closed. Candidate/verified objects, uncertain effects and interrupted custody are retained; there is no age-based lease stealing or automatic pack cleanup. A full lane or unverified owner is explicitly non-ready. Replace/graft history overlays are refused rather than mistaken for the raw object graph.

## Process custody

Cancellation records use operation-specific paths and must match both operation and token. A delayed old request cannot overwrite a replacement operation's request. Ownership is rechecked after publishing the request; replacement cannot authorize cancelling the replacement, removing its lease or a ready result. Lease release requires the owned subprocess scope to close and its exact witness to match. An interrupted or mismatched witness retains custody even if a verified ref was already created.

Success is provisional until actual helper closure and final cancellation/failure reconciliation. Cancellation admitted during shutdown produces a blocked receipt/result, never a verified receipt with a cancellation reason. The terminal decision is sealed after closure and the final cancellation drain, before publishing that outcome; later cancellation does not undo an already completed graph operation. Unknown closure cannot release custody.

The subprocess helper uses maintained trusted Git/watchdog discovery. A forked alarm supervisor keeps its deadline separate from Git's progress timer and limits the owned process group even if the helper dies. Missing/unsupported watchdog or loader policy is refused; there is no unbounded fallback. Per-file storage limits are inherited by native Git children. These process/platform claims require their actual native tests, not only a timestamp or a JSON `closed` flag. [Helper](../mcp/src/runtime/fetch-process.js), [owner-loss/cancellation tests](../../../tests/desk/mcp/__tests__/runtime/fetch_owner.test.js).

On the qualified macOS shell, file limits use 1,024-byte blocks, rounded down to stay within the requested byte ceiling. A failed transfer that leaves a newly changed pack file exactly at that ceiling reports the observed storage limit, even when Git only reports an invalid index-pack result; pre-existing unchanged packs are not evidence of this job reaching its limit. No partial pack is deleted to manufacture success.
