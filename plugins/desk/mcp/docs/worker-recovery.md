# Worker recovery contract

Runtime maintainers: the dependency-light foreground entry resolves the existing desk binding, reads bounded local instructions and starts or joins one recorded background operation. It does not restore dependency packs, scan tasks, run Git, wait for a remote, apply migrations or install hooks. Its startup contract is 3000 ms from process entry, including imports and dispatch. Full boot and dependency restoration load dynamically only in the accepted background operation or explicit diagnostic path. The cold-entry tests exercise the real CLI with the restored dependency pack present. See [the CLI](../scripts/session-boot.js), [foreground boot](../src/runtime/boot-entry.js) and [the acceptance tests](../../../../tests/desk/mcp/__tests__/runtime/worker_recovery.test.js).

## Custody and settlement

The existing sync worker receives a unique operation ID. A protected reservation and a durable grant name its PID; the worker records acceptance before native work. Foreground boot may return a pending reservation before acceptance. Pending is neither synchronized nor failed. The worker waits briefly for a grant that races its startup; an absent grant never authorizes native work. See [the operation implementation](../src/runtime/recovery-state.js).

The operation binds the canonical root, Git directory, common Git directory, branch, activation context, effective fetch and push routes, captured Git policy and reference-hook evidence. Each fetch targets an operation-specific ref. Incoming graph, outgoing delivery, committed source, required LFS bytes and background checks retain separate states. A different push destination or required LFS content cannot inherit successful verification from fetch equality. Historical success is not current evidence: local status validates the current `.git` to administration directory to `commondir` resolution chain, physical directory identities, configuration/activation proofs and source head without a remote query. Every successful no-work outcome still requires the current symbolic branch; it cannot bypass branch validation because it omitted commit equality. Unavailable or changed proof cannot report synchronized. See [the binding implementation](../src/runtime/recovery-state.js) and [the binding regressions](../../../../tests/desk/mcp/__tests__/runtime/recovery_review.test.js).

Only the operation owner settles its record. Native work uses private IPC to an exclusive native owner within the existing worker script. Before commands start, an independently surviving, same-group watchdog records its actual generation and arms the whole-operation deadline. The owner and watchdog each terminate only their own live group, whose membership prevents numeric group reuse; the outer worker does not signal a stale PGID. Inspector and migration children inherit that group. A leader exit or closed stdio alone is not all-child closure. See [the ownership implementation](../src/runtime/recovery-state.js) and [native single-loss/multifault tests](../../../../tests/desk/mcp/__tests__/runtime/recovery_process_custody.test.js).

Bootstrap identity observation can retry a transient unavailable OS read within the existing 5000 ms bootstrap cap; each read remains capped at 1000 ms, and the watchdog's self/parent observation is one batch. No command grant or Git attempt is retried by that observation loop. Persistent uncertainty still refuses before native effects. Bounded bootstrap messages and watchdog exit code/signal/redacted stderr remain in the operation evidence. A failed pregrant attempt is distinct from an unknown dispatched-command outcome. See [bootstrap implementation](../src/runtime/recovery-state.js) and [transient/persistent real-process fixtures](../../../../tests/desk/mcp/__tests__/runtime/recovery_process_custody.test.js).

An unavailable closure inventory is not evidence that descendants outlived their command. If no live descendant has been observed, its bounded read can retry within the existing whole-operation deadline without replaying that command. Once positive evidence activates the short descendant-cleanup grace, that bound remains active across later unknown or empty inventories. Reads and pauses fit its remaining time, and an empty observation arriving after expiry cannot admit clean settlement. See [native settlement](../src/runtime/recovery-state.js) and [mixed-inventory grace fixtures](../../../../tests/desk/mcp/__tests__/runtime/recovery_process_custody.test.js).

An unreadable record, unverifiable generation, lost settlement owner or unproven child shutdown remains unknown and blocks replacement, including an outgoing worker. A new pending operation retains known incoming failure and prior background-check barriers separately. An absent remote or failed local Git observation cannot drop that incoming history; compact status exposes it ahead of the separate pending-operation line. Only verified resolution of the observed failure can clear it; successful outgoing work or elapsed time cannot. Local status does not contact a remote. See [status propagation](../src/tools/status.js), [compact status](../src/runtime/status-compact.js) and [failure-continuity tests](../../../../tests/desk/mcp/__tests__/runtime/recovery_review.test.js).

A validated `no_remote` or `no_upstream` result is no-work evidence, not verified incoming resolution. It does not erase a known incoming failure in the current read, boot/compact health or the next reservation's lineage. Without prior failure, repeated no-work results remain healthy and do not invent a failure. The shared resolution predicate requires synchronized state and verified incoming evidence. See [the predicate](../src/runtime/health.js) and [no-work worker/lineage tests](../../../../tests/desk/mcp/__tests__/runtime/recovery_review.test.js).

After proven all-child closure and unchanged binding, loss of a native fetch response permits local private-ref/object readback and at most one new fetch attempt in the same operation. The original unknown response and observed readback remain recorded. This exception is limited to derived private-ref fetches: it is not permission to replay push, source application or hooks. See [the main-worker loss fixture](../../../../tests/desk/mcp/__tests__/runtime/worker_recovery.test.js).

## Background inspection does not apply repairs without custody

Background boot uses migration inspection only. A detected safe migration remains pending; an incomplete migration check remains incomplete. It does not execute Safety check or Migrate, install a card guard, rewrite local-only cards or launch a plugin refresh while the task is already running. Existing migration callers retain their default behavior. Dependent admission, schema and mutation gates remain in force; conversation and independent authorized work do not wait. An incomplete read-only inspection can retry once, only after all nested closure is known, the binding is unchanged and the original whole deadline has room. Each attempt keeps the production 2000 ms migration budget and its own receipt; this does not guarantee availability under every load. See [migration inspection](../src/runtime/pending-migrations.js), [inspection safety tests](../../../../tests/desk/mcp/__tests__/runtime/recovery_migrations.test.js) and [the production-budget recovery fixture](../../../../tests/desk/mcp/__tests__/runtime/worker_recovery.test.js).

## Qualification boundary

### Outgoing publication runtime slice

The separate [publication runtime](../src/runtime/publication-state.js) records an immutable commit target, original enqueue deadline, root/person/binding, worker acceptance, command attempts and exact remote readback. `queued`, worker-accepted and remotely verified are different evidence. `flushPublication` observes a ticket; it cannot mint an intent, replay a mutation or restart its lifetime. Closing its opaque producer context rejects new requests, but does not cancel an accepted ticket. A fresh authorized context for the same binding can observe that durable ticket without reusing the old intent. Serialized contexts or intents do not carry authority.

Binding capture belongs to the authorized intent operation, not foreground session initialization. That operation captures branch, administration/common-directory resolution, route, local hook and server policy before enqueue; the ticket preserves those inputs rather than adopting whatever the worker finds later. Context reuse cannot adopt another branch or root policy, and the worker checks the captured proof before effects or observation. A later independent local HEAD advance remains allowed. Server policy includes `post-update`, which receive-pack can invoke after updating refs; an executable hook is blocked, not disabled.

Local destination authority includes the original path's resolution chain, including directory/link identities and its canonical repository. The chain is revalidated before enqueue, native admission and verification; Git receives the approved canonical destination rather than an unresolved alias. An observer's already captured binding is enforced independently of the ticket's applicability. A new observer establishes its binding lazily from current local authority, not by adopting the ticket; a matching scope key alone cannot bypass stale configuration identities.

Symlink-sensitive `.`/`..` traversal is not qualified: it is rejected before enqueue, before any lexical path collapse or file-URL normalization can select another repository. Captured routes must match the untrimmed native route output, excluding only its terminal newline. File-URL parent components are checked in their raw decoded path, including percent-encoded dots; parser-discarded raw characters and decoded-path substitutions are refused rather than reinterpreted. Encoded tabs and spaces retain their actual pathname. The context's original root identity is checked before and after lazy authority capture, before installing binding authority, after receipt loading and after the final terminal reread; a replacement repository at the same pathname cannot inherit an old unbound context. See [capture, resolution and observation](../src/runtime/publication-state.js) and [raw-route/root-race controls](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js).

An old complete atomic FD remains readable as a snapshot, but current ticket/grant reads check its pathname identity and metadata with at most one reread. Terminal verification is rechecked against the current ticket generation after local applicability inspection; persistent replacement is explicit UNKNOWN, never stale verified evidence. Queue inventory streams retained records with a directory cursor and yields every 256 entries. That is a continuation bound, not a total-history cap. An incomplete inventory cannot establish no work or safe release; retained receipts are not deleted to make queued work visible.

Each cooperating enqueue also publishes a protected per-ticket pending notification. Notifications survive a directory cursor reaching EOF and a retiring owner's deadline crossing. Once closure is proved, the owner can hand off a live queued ticket to a new worker under that ticket's unchanged original deadline. Retirement has a separate 1000 ms monotonic metadata-only observation bound; it does not extend an old ticket or admit old Git work. Unknown custody or failed/tampered pending inventory remains visible and retains the notification; it is not cleared by age. A preflight failure does not authorize an unbounded same-ticket admission loop. Active reservations publish complete payloads with atomic no-clobber links, never a visible empty JSON file; unsupported atomic publication is explicitly blocked without a weaker fallback.

The near-retirement check also occurs before selecting queued work, not just after directory EOF. Configuration, target, LFS, private-ref and dependency preflights use the existing contained native owner/watchdog, with separate `inspections` receipts and independently proved group/stdio closure. Each inspection has a fixed deadline capped at 5000 ms and the old owner's remaining life; expiry is checked before every local or remote admission, never clamped into a new 1 ms command. A positively undispatched expired primitive does not manufacture an outgoing phase attempt. See [owned inspection and admission](../src/runtime/publication-state.js).

If the old owner's budget expires during a local preflight, the ticket remains queued only when its own original deadline is still live, no outgoing phase was attempted and every inspection/helper is independently known closed. The notification, first acceptance, inspection history and original deadline remain. An independent inspection timeout is a blocker, not handoff authority; unknown closure remains UNKNOWN. The exception does not requeue dispatched outgoing phases or replay a push. Existing phase/effect/closure evidence stays authoritative after dispatch. See [settlement and retirement](../src/runtime/publication-state.js) and [controlled expiry paths plus native inspection-timeout fixture](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js).

The inspection's independent limit and publication limit are selected once at entry, before policy checks or admission. Its receipt retains `deadlineCause`: `publication` only when that bound was strictly earlier, `inspection` when the independent bound was earlier, and `ambiguous` for equality. Independent or ambiguous expiry remains `ETIMEDOUT`, including pre-admission expiry and settlement after delayed closure; later wall-clock owner expiry cannot create handoff authority. This also applies when the command succeeded but closure exhausted the inspection budget: its successful status and actual closure remain recorded, without invented cancellation or effect absence. See [immutable inspection budgeting](../src/runtime/publication-state.js) and [before/after-closure, equality and pre-admission controls](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js).

Expiry does not override an explicit refusal, spawn/command failure or phase-specific policy result. Each inspection validates its own successful or expected-absence semantics before timeout can authorize handoff: configuration policy, commit type, LFS absence, exact private-ref readback and dependency ancestry. An operation cancellation is terminal even if the retained command succeeded; the receipt preserves `cancelled`, status and closure, and cannot authorize another phase or handoff. Unknown closure still takes precedence over clean settlement. See [inspection result precedence](../src/runtime/publication-state.js) and [exact-primitive virtual refusal/policy/cancellation controls](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js).

Truncated inspection output remains incomplete proof even when the native result also reports a deadline; it cannot authorize handoff. Outgoing observation, graph, push and readback receipts also retain cancellation, truncation and elapsed-budget evidence. After known closure, cancellation or truncated proof stops phase acceptance and further mutation. Before push this blocks publication; after a dispatched push it remains UNKNOWN without replay or a claim that no effect occurred. The recorded command status is not rewritten. See [outgoing settlement guards](../src/runtime/publication-state.js) and [all-phase exact-primitive virtual controls](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js).

The existing worker script's publication mode supports native fast-forward delivery to a local bare/file destination without changing shared HEAD, index or pending bytes. A later local commit does not change the earlier authorized target. Non-fast-forward dependent targets, executable local/server hooks, unsupported policy and LFS remain blocked. Its raw trusted-fixture commit minting is not producer-attribution proof. The first participating producer unit is described below; the legacy publication scheduler and other producers remain separate integration gaps.

At most one additional native admission per phase is permitted for an eligible bootstrap-observation failure, only when no run/grant message was sent, all helper closure is proved, current grant/revision/binding still match and the original deadline remains. Explicit identity/group refusals and unclassified watchdog exits are not retry authority. After push, only readback admission can retry, never push. Unknown dispatch or closure remains UNKNOWN without automatic replay, even after the caller closes and a fresh context flushes the ticket. The [publication controls](../../../../tests/desk/mcp/__tests__/runtime/publication_recovery.test.js) distinguish a clean startup exit from an explicit private-channel refusal and an unavailable after-push closure observation; these controls do not explain historical identity-read failures.

Native SSH/authenticated HTTP, signed producer receipt attribution, same-branch independent candidate construction across a foreign conflict, dead-worker reconciliation, coordinated source/LFS/migration custody and installed-consumer qualification remain open. A different-file fast-forward fixture is not proof of semantic independence.

### First producer integration unit

The participating `commitPaths` and `commitIndexPaths` helpers accept an internal opaque `publicationContext` after their existing state-branch positional argument; callers without it retain synchronous legacy behavior. Participating calls return promises with the existing successful `{ ok, stderr }` shape. The admitted session supplies this context only after its write-authority and branch gates; its producer context requires an actual branded receipt rather than caller-supplied HEAD. `desk_save` checks root/person/branch/binding after validation waits and immediately before each hosted mutation, retaining completed and uncertain paths on failure between files. The helper independently confines normalized selections and every expanded exact path/index entry to the context's actual person prefix; directory, `.` and `./` selections do not weaken attribution. See [helpers](../src/util/git-stage.js), [session injection](../src/runtime/desk-session.js), [save](../src/tools/desk-save.js) and [producer controls](../../../../tests/desk/mcp/__tests__/runtime/publication_producer.test.js).

An operation-specific reflog witness qualifies only with independently closed native commit custody, one matching witness, the expected parent and exact path/blob/mode readback under current binding. Existing caller `GIT_REFLOG_ACTION` is preserved exactly; inability to mint a safe witness leaves the actual commit explicitly unqualified and does not fall back to root-only publication. Pruned or ambiguous nested-hook witnesses and unexpected write sets cannot select latest HEAD. The private index path commits captured entries without rewriting staged foreign bytes or later working drafts. A narrowly qualified lost native response can use exact commit readback without repeating the commit. Producer journals retain command and resource evidence separately from publication tickets. See [receipt foundation](../src/runtime/publication-state.js).

A confirmed plain directory retains non-Git save behavior without creating Git publication authority; failed repository observation cannot use that exception. An unborn branch's initial commit requires positively absent branch/HEAD observations, the zero-old-ID reflog witness and an exact parentless commit/tree readback, not an invented parent. A proved commit with an ordinary nonzero native outcome retains its original failure and attributed effects; `desk_save` can expose its exact receipt-backed ticket without claiming the command succeeded. Private-index preparation runs under owned native custody and records its groups separately. Cleanup covers preparation as well as commit: positively undispatched or independently known-closed resources may be removed, but unknown preparation/commit custody retains the exact resource. See [producer qualification and preparation](../src/runtime/publication-state.js).

Producer-journal writes from native resource callbacks contain persistence exceptions and retain the first error; the existing owned process settles before that failure is returned. Persistence failure is explicit even when commit attribution succeeds, with command/closure evidence and the bound receipt retained. Private-index cleanup failure cannot replace a successful commit or an earlier preparation error: it adds the cleanup error and exact retained resource to the primary effects. Cleanup-only failure does not rewrite command success, and unknown custody never permits removal. See [producer persistence and cleanup settlement](../src/runtime/publication-state.js) and [callback/cleanup controls](../../../../tests/desk/mcp/__tests__/runtime/publication_producer.test.js).

Every preparation phase records and checks its initial state before native admission. After the first journal failure, resource observations remain in memory and no further journal write is attempted. Each journal temporary is exclusively created, closed before rename, and either removed by its exact path or reported with its cleanup error and retained path. The original filesystem path/destination remain separate from the logical journal path. A settled preparation failure remains primary when persistence also fails; persistence is primary only when preparation succeeded. See [preparation admission and journal custody](../src/runtime/publication-state.js).

Journal creation ownership and confirmed descriptor closure are separate evidence. Failed close retains uncertain descriptor/path custody without retrying that descriptor or unlinking its path. A write failure remains primary if close also fails. Before rename or removal, the current regular-file identity must match the exclusively created descriptor's device/inode; missing, replaced or unreadable identity refuses the step and retains its exact path. These checks do not claim an atomic fence against arbitrary concurrent writers. See [journal descriptor and identity handling](../src/runtime/publication-state.js) and [controlled close/replacement faults](../../../../tests/desk/mcp/__tests__/runtime/publication_producer.test.js).

Private-index directories likewise retain their creation identity and individually observed owned child identities. Cleanup checks the current directory and complete child inventory before removing only matching owned files, then removes the empty matching directory; it never recursively removes unidentified descendants. Replaced directories, foreign children or unavailable identity retain the exact resource and uncertainty without discarding an attributed commit or ticket. Every producer record and failed/cleanup result carries the private resource's path, identity and custody, including native closure UNKNOWN and persistence failure; save serialization preserves those fields. Point-in-time ownership checks do not establish atomic editor exclusion. See [private-resource settlement](../src/runtime/publication-state.js) and [linked tidy-save custody controls](../../../../tests/desk/mcp/__tests__/runtime/publication_producer.test.js).

An observed child identity is never overwritten by a later pathname lookup. Identity transitions retain the original and later observations as UNKNOWN unless independently attributed; the current producer unit conservatively retains such private resources even when native Git normally replaces its index. This does not invalidate separately proved commit attribution. Cleanup records each confirmed removal and the failed or uncertain next step before returning partial custody; cleanup updates preserve the original qualification or refusal reason. See [child observations and removal history](../src/runtime/publication-state.js).

Local commit, qualified receipt, queued ticket and exact remote verification remain separate states. Graceful session disposal waits for admitted operations before closing their producer context; an already accepted publication ticket survives and can be observed by a fresh same-authority context. Abrupt caller-process loss before ticket creation, complete writer coverage, before-write editor fences and general signing qualification remain open. This first unit does not wire other mutators or upstream note/inbox producers; their current public interfaces must be retained during composition, not overwritten with older whole files. Its source and native controls still require fresh review before broad producer wiring. See [session lifecycle](../src/runtime/desk-session.js) and [producer qualification tests](../../../../tests/desk/mcp/__tests__/runtime/publication_producer.test.js).

### Accepted producer lifecycle Gate1

The separate [producer Gate1 runtime](../src/runtime/producer-state.js) implements reservation, private caller-channel transfer, accepted worker ownership and read-only executor qualification only. It is not connected to hosted save writes, staging, commits or publication. Intent creation selects the original producer 10000 ms and publication 60000 ms deadlines before authority capture; dispatch, acceptance, observation and caller loss never reset them. An opaque intent, not a serialized request or operation ID, authorizes dispatch.

The existing worker script starts the detached producer mode through private IPC. The caller records attempted grant delivery before send; the worker records its current accepted grant before native admission. Caller loss after that transfer does not cancel independently owned read-only work. Before-send reservation and unacknowledged delivery remain distinct evidence, not accepted mutation or no-effect claims.

A one-use nonce binds the ephemeral per-operation Unix socket to the intended spawned native executor. Node net sockets provide no kernel peer-PID authentication: the broker independently checks reported executor identity against actual PID/start/group/parent observations, the current owner/native resource witnesses and current grant revision. Invalid nonce, stale/reused generation, wrong parent/group, closed channel or unavailable proof cannot grant execution. The qualified executor only emits a fixed read-only acknowledgement; no writable producer capability is exposed. See [Gate1 relationship and lifecycle controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate1.test.js).

Native owner/watchdog custody, original deadlines, group/stdio closure, explicit blocked or UNKNOWN outcomes and exact broker cleanup are recorded. Persistence failure stops recording and remains explicit; stale accepted metadata cannot establish terminal settlement. This Gate1 proof does not qualify the forthcoming write/stage/commit executor, worker/controller orphan recovery, other platforms, kernel credentials or integrated startup latency. The ordinary boot path is unchanged; Gate2 mutation integration requires its own reviewed gate.

Gate1 journal transitions use an exclusive per-record writer lock plus the expected current pathname identity, exact content and revision. Caller-to-worker acceptance cannot overwrite a substituted or newer record; stale writers refuse without automatic lock takeover. Verified records require the accepted owner/dispatch, actual relationship, exact acknowledgement, successful complete outcome and known native closure—not just a state string. Older incomplete records remain unqualified rather than gaining compatibility through false proof.

One persistence-error latch covers reservation, acceptance, resource callbacks, settlement, catch and cleanup. The first filesystem error and exact descriptor/temporary/transition-lock custody are retained; later paths update observations in memory but do not write again. Broker peer errors are bounded observational channel failures, contained without cancelling accepted native work. See [Gate1 journal and peer controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate1.test.js).

The latch also stops journal reads after a resource read or write failure. It captures the original observation error directly, not through another attempted record transition. Native status/output/error/cancellation/truncation and resources are retained in memory before terminal proof publication. Broker allocation and identity lookup are inside the protected lifecycle; an allocated path is retained before identity is available, and uncertain identity never permits cleanup. Terminal proof requires literal native closure flags, typed nonempty generation/token/group fields and an actual empty member array. See [exact-source error and proof controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate1_error_paths.test.js).

Broker journal reads and schema validation use the same first-error latch; malformed peer input, wrong nonces and peer resets remain local channel refusals. The complete native outcome—including spawn failure—is constructed once and reused through terminal, catch and cleanup evidence. Each acquired broker directory or socket identity is recorded in memory before the next fallible setup step. Qualification also requires literal capability grant truth, no spawn failure and matching owner-group evidence, with correctly formatted observed generations. The source controls validate unchanged actual sealed positives before applying contradictory-field mutations; they do not qualify another native run.

Journal observations compare the entire current accepted record with the immutable content digest of the last successful authenticated transition. A schema-valid change to native resources, owner or grant state is therefore latched as the original grant inconsistency before peer qualification and again immediately before capability delivery. It cannot be downgraded into a peer refusal followed by more journal I/O. Legitimate writer transitions advance that expected digest; peer JSON, nonce or relationship refusals do not change the expected grant or create persistence failure.

### Gate2 FIRST save body source unit

The admitted session's participating save route reserves producer work before touching target files or staging. Input stays the existing paths/files/message/tidy shape; the internal context selects this route, not a tool JSON flag. Private payload files retain creation identities and hashes outside Git, and content transfers in bounded chunks to the intended executor through the existing qualified broker. Only that live exchange creates the opaque execution capability. Pending producer admission is not a local commit or publication.

The [contained body](../src/runtime/producer-body.js) validates the same save/path/person/card policy and rechecks authority after waits. Each filesystem, stage, private-index preparation and commit mutation requires a persisted monotonically numbered broker approval before dispatch. Close is a separate descriptor-bound phase: an open result reports its descriptor before write/close approval, and a lost write/report/approval leaves explicit descriptor uncertainty for actual outer settlement rather than an unapproved finally-close. Duplicate phase approval cannot replay a mutation. Git timeouts and authority inspections use the remaining original producer deadline, selected before participating preflight/module dispatch; validation and payload loops check that deadline after awaits. Inner helpers do not create another native owner, reset ten seconds, wait for ancestor closure or mint publication receipts.

Public save input requires each supplied `paths` or `files` array to be nonempty; callers omit an unused dimension rather than sending an empty array. Authenticated producer payloads retain both canonical arrays for their existing digest and transfer format. At body revalidation, a private typed, original-deadline-bound view omits only canonically empty dimensions before calling the unchanged public validator. It rejects malformed or wholly empty canonical payloads, preserves nonempty arrays and content without mutation, and does not relax public schema, path policy, actor checks or phase approvals. A paths-only no-op therefore has no file-write phase; this source behavior is not evidence of installed or native recovery completion.

Actual acquired handle objects are strongly held in a private module-lifetime collection before an open-result report can await. They are removed only after an approved close actually succeeds, not on an error, unwind or capability deactivation. This prevents an otherwise unreachable promise-based FileHandle from being garbage-collected into an unapproved close; uncertain handles remain held until the owned process settles. Numeric descriptor journal records alone do not provide that JavaScript object custody.

The executor returns provisional effects, command outcome and witness information, never publication authority. After the outer native group settles, the surviving metadata owner can qualify the original witness/parent/path/blob/mode under current binding within the same remaining deadline. Its receipt is privately bound to the actual native result object. An ordinary failed command stays failed even if a matching commit witness exists; only the qualified native-response-loss class can recover attribution, retaining the original native null/error and a distinct recovery classification. No selected staged delta settles `nothing_to_commit` before private-index/commit dispatch and does not seek a nonexistent new witness. Tidy checks only selected staged cards while still refusing incomplete renames; foreign staged entries are untouched.

Private payload capture, storage readback and chunk receive share an order-independent, length-framed incremental digest over canonical fields and UTF-8 content. They never serialize a raw multi-file content aggregate. Ordinary body/native journals and projections retain command status/error and output byte counts/hashes, not arbitrary hook stdout/stderr or token-only masks. Raw output is intentionally not retained (`rawRetained: false`); failures remain visible by code/status and attributable output hashes. Native failure, partial writes, failed close, missing approval or unknown closure remain explicit; no stage/commit replay or root-only scheduler follows. Private index resources remain conservatively retained because native identity transitions are not independently attributed.

This is a source implementation unit awaiting independent review and controlled writable native qualification. Actor-free body and protocol tests do not prove actual caller loss after a hosted write or stage. Gate3 ticket linking/push, durable orphan recovery, other producer/note/inbox wiring, writer fences, signing/transports and installed/integrated startup remain separate open gates. See [body controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate2_body.test.js) and [protocol controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate2_protocol.test.js).

### FIRST producer currentness candidate

The FIRST save caller, surviving metadata owner and intended executor each create an independent, local WeakMap-branded currentness monitor from their existing private context and authenticated operation transfer. Initial capture separates provisional discovery from complete input snapshots and a reference pass; every reference query checks physical input and lookup epochs before and after the actual call. Reference config/origin/route outputs must match discovery, with no late input adoption. Config closure includes absent repository/worktree/global/system scopes and declared inactive includes; unknown conditional selectors, search provenance and unreadable inputs refuse.

Bare-endpoint closure reads actual `--local --show-origin` output and includes that observation in the reference pass; it does not manufacture an origin at the endpoint's `config` path. This candidate refuses a bare endpoint with a `commondir` indirection or an environment common-directory override selecting another directory. It supports the directly resolved bare config/worktree scope only, with the pointer's absence witnessed for later checks. Refusal is not qualification of an unsupported alternate common config.

Steady checks reread exact root/admin/common/branch/config/environment/route/hook/server input witnesses without spawning the original authority-query plan again. Deadline checks occur inside each witness-read/scan sequence, not only outside a whole legacy helper. The original producer deadline is never reset. The original publication and read-only Gate1 mechanisms are not converted to this new monitor.

Direct invocation qualification remains narrow. Its existing positive class requires a complete bounded ELF64 static executable image with a file-backed executable entry, no interpreter/dynamic segments, no recognized loader/implementation-selection overrides, and exact original executable/helper bytes and lookup provenance. Unregistered dynamic images, scripts, custom wrappers and larger-than-bound direct binaries remain unqualified. A separate operation-owned Apple route is described below; neither class treats format, version, path or hash as executable authentication or native performance proof. Refused invocation never falls back to the old expensive mutation path.

Readonly system-image observation is separate from invocation admission and exclusive private-resource custody. Actual advertised-Git/helper discovery derives private, original-deadline-bound input roles; capture, S0/reference sealing and retained monitor copies preserve those roles locally. Transferred footprint/role JSON is comparison data only: each actor independently captures its inputs, and neither a copied role nor an image-kind flag selects this reader or creates a monitor. This does not relax the single-link private/config/payload readers, private index/temp/FD cleanup, or the per-file 1MiB payload bound.

The system reader records stable regular targets with their actual `nlink >= 1`, exact BigInt device/inode/mode/uid/gid/link-count/size/timestamps and bounded named symlink chains. It opens the resolved target readonly/no-follow/nonblocking, checks FD/path/link identity before and after the read, and incrementally hashes every byte through one fixed 64KiB byte buffer using sequential descriptor offsets and a BigInt byte count. Short reads continue to actual EOF; early EOF, growth or input/version/alias drift refuses completion. Every currentness comparison rereads the full content, including when stat data is unchanged: there is no prefix-as-full digest, TTL, stat-only reuse or adoption of a changed witness. Path metadata and existing private/config buffers are separate from that image-byte buffer; this is not a bound on total process memory.

Original-deadline checks surround each image IO/chunk and final witness publication. Read failure/expiry retains the known returned-byte count and partial digest as explicitly incomplete evidence; its own readonly FD receives one close attempt, with the primary error and secondary close uncertainty retained. Even complete bytes cannot qualify a witness after close failure or expiry. These checks do not preempt a single blocked filesystem syscall. The existing single-link, 1MiB direct static-format class is unchanged. Streaming larger/hardlinked inputs alone grants no invocation permission. No image hashing runs at module load or adds foreground startup work; source controls establish neither native timing nor a working installed Mac provider.

### Operation-owned Apple developer selection candidate

This FIRST-only source candidate intentionally amends the earlier unchanged-environment rule. The original operation ID, `t0`, producer cutoff (`t0 + 10s`) and publication cutoff (`t0 + 60s`) exist before selection. A private WeakMap registration binds an immutable operation environment before discovery; it does not edit `process.env`, the caller's publication context/environment/binding, PATH, an installed Git, or global developer settings.

An existing `DEVELOPER_DIR` is validated and preserved byte-for-byte. Supported forms are the recognized absolute Developer contents directory and Apple's documented absolute `.app` form, with the named app/contents/canonical chains independently witnessed; ordinary spaces are preserved. Empty, nonstring, non-roundtrippable UTF-8, relative, expanded/token, ambiguous or unsupported forms refuse rather than being overwritten. The active root/base scope is checked before a selection helper can launch. When absent, the production path selects once through the existing owned `xcode-select --print-path` mechanism within the ORIGINAL remaining time. A status/output/closure failure retains its actual observation and blocks before discovery; it never reuses an earlier getter or resets a deadline.

The resulting explicit A defines this NEW operation's contract, not a lease on the global selection. Later global A-to-B changes intentionally do not reselect/cancel a stable operation; changes to A's named aliases, directory/image/helper/configuration or relevant input bytes still invalidate it. The new environment differs in exactly one inserted selector key, or zero keys when inherited. Caller, accepted owner and intended executor each obtain their own registration through the existing authenticated actor/grant/revision/deadline path. Selector metadata and digests travel as private comparison data; copied JSON cannot mint a registration or monitor. The owner/executor compare their actual inherited environment to the authenticated operation environment and never query global selection again.

The advertised command stays `/usr/bin/git`. A locally registered known-Xcode route can have different dispatcher and engine inodes, but it must map to the witnessed Developer `usr/bin/git` and `usr/libexec/git-core/git` alias, with the known alternative lookup absence/epochs and full input closure. The engine's complete Mach64 header/load-command region is interpreted within the same fixed 64KiB image buffer, including short reads, before reuse. Supported platform-library/loader declarations are structural evidence within the trusted installed-OS contract, not format/hash authentication; unknown/overbound forms, embedded/search redirects and unresolved non-platform dependencies refuse.

This first route refuses presence of `SDKROOT`, `TOOLCHAINS`, `GIT_EXEC_PATH`, loader overrides and xcrun cache/log/verbose flags, including empty/default spellings; it does not unset user inputs. Documented OS cache/override correctness and normal shim transformations are explicit source premises, not findings about the installed host or private cache routing. Unexpected SDK-specific/external engine/helper paths fail closure. Actual native use still needs separate qualification and incidental cache-effect scope; a consumed getter exception supplies neither.

The selector is part of immutable `commandBaseEnv` equality, not a mutable environment allowlist. Actual command options still allow only the existing commit/prompt/reflog/private-index overlays. Full source/currentness witnesses and live registration are checked during streams and around reference dispatches, then after every await and at the synchronous imminent-effect fence. Loss of authority stops the next read/dispatch, without erasing earlier file effects. Retirement of one actor's registration does not retire another actor or release uncertain native/FileHandle/index custody.

Schema2 body-start and terminal reports travel over the same live peer. The metadata owner validates original operation/deadlines, phase sequence, command/proof/output and resource observations before completion count or acknowledgment; terminal persistence failure retains validated memory/effect evidence without sending an ACK. Ordinary failed operations stay failed. Duplicate terminal reports cannot obtain another completion ACK. The new lifecycle distinguishes issued grant, observed body invocation and validated completed report; an issued but unobserved body is unknown, not zero execution. Historical FIRST journals retain their raw counters and receive a separate observation explaining that the old counter meant completed body report. Neither count nor currentness data implies safe retry.

Caller monitor retirement does not retire accepted work. Owner/executor monitors are independently captured against the originally transferred authority and footprint, and their native actor checks remain mandatory before grants and after waits. Actual Git command environment is compared before dispatch; only the existing fixed operation overlays, exact caller reflog action and privately registered index path are allowed. Owner receipt attribution still waits for actual outer group/stdio closure and performs current-scope exact readback within the remaining original deadline.

The contained body renews policy, capability, channel and actor checks after the final awaited target resolution. It also makes a synchronous assertion after the awaited approval/check chain immediately before invoking the effect; a changed policy or disconnected peer cannot proceed to `O_TRUNC` using only the preceding check. The async validation API remains compatible. Broker phase results require the exact supported result fields and literal `status: "completed"` before changing journal history, marking a descriptor closed or acknowledging completion. Failed, missing or malformed status leaves the admitted phase uncertain and cannot validate a later no-op terminal report.

This is a new source-only candidate requiring fresh code review. [Complete-capture controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate2_capture.test.js), [primitive/currentness controls](../../../../tests/desk/mcp/__tests__/runtime/producer_gate2_currentness.test.js) and the existing body/protocol tests use injected filesystem/process/query boundaries, not writable native actors. Both earlier failed smoke operations, including the truncated target and original deadlines, remain historical failures. No native rerun, caller-loss acceptance, Gate3 publication, installed consumer or startup latency is established by these tests.

### Recovery field guide: bring receipts, not optimism

For a 30-second orientation (not a startup-latency promise), find the operation's original returned root/directory, ID, deadline, current owner and last qualified receipt. Read the actual caller's entrypoint before invoking a helper. A correct refusal may still leave the user's requested recovery undelivered; a new attempt must not masquerade as continuation of an uncertain attempt's clock.

| Evidence | Establishes | Does not establish |
|---|---|---|
| Source review and actor-free controls | Exercised implementation branches and counterexamples | Native closure, installed activation or startup latency |
| An owned native getter | That exact command's response and qualified bounded resource settlement | Complete invocation/currentness, a successful writable body or reboot durability |
| An installed recovery cycle | The particular installed entrypoint/event actually exercised | Other platforms/events or repeated-event durability |

Use canonical paths returned by the owning API, rather than reconstructing string-derived keys from lexical aliases. Check actual capability/channel/actor/target state after the last await. Input identity never supplies private cleanup rights. Timers are wakeups, not cutoff proof: microtasks can run before an overdue timer; process exit and stdio/group closure are different observations.

A save with recorded `mkdir` and truncating `open`, then no completed terminal report, can have an empty target AND a zero completed-report count. Keep grant, observed invocation, applied/unknown file effects, terminal completion and native closure separate. Zero reports are not zero execution or permission to retry. Preserve original outcomes/resources and any scoped readback; do not rewrite a failed observer into a clean story.

From the repository root, the focused source selection is shown below. Inspect current test sources/instructions first: this example does not authorize held native operations, and a smaller-looking selector can import a native fixture.

```sh
node --test \
  tests/desk/mcp/__tests__/runtime/producer_gate2_currentness.test.js \
  tests/desk/mcp/__tests__/runtime/producer_gate2_capture.test.js \
  tests/desk/mcp/__tests__/runtime/producer_gate2_body.test.js \
  tests/desk/mcp/__tests__/runtime/producer_gate2_protocol.test.js \
  tests/desk/mcp/__tests__/runtime/producer_gate1_error_paths.test.js
```

Start at [foreground boot](../src/runtime/boot-entry.js), [native custody](../src/runtime/recovery-state.js), [currentness](../src/runtime/publication-state.js) and [producer protocol](../src/runtime/producer-state.js). A useful handoff names the canonical task/writer, exact source hashes, accepted gate, unresolved user outcome, original operation/deadlines, retained resources and safe next action. A green helper, idle notification or longer victory speech is not the caller's acceptance or another writer's release.

The accepted Task1 operation exercises native local/file fetches and readback of already-converged committed source on macOS. It does not apply incoming source changes, deliver outgoing commits through that operation, hydrate LFS files or qualify SSH, HTTP, executable reference hooks or Windows native-child custody. Those remain explicit barriers, not successful synchronization. The separate outgoing runtime slice above does not extend Task1 qualification. Linux code paths require their own native qualification; macOS process-start observations use the platform's second-resolution `lstart` value. Safe migration application also requires coordinated writer custody; inspection does not supply it. See [the worker's refusals and platform handling](../src/runtime/recovery-state.js).

The independent watchdog bounds contained actors after a single native-owner loss; the native owner bounds actors after a single watchdog loss. Loss of the outer settlement worker still retains unknown operation custody even when contained actors stop. Multiple controller losses can leave executable actors; the operation must not claim finite closure or dispatch a replacement. Multifault fixture retirement is recorded separately from product closure. Operation records, diagnostic output and private incoming refs are retained as evidence, not cleared by age. Source tests are not fresh-review acceptance, installation or release qualification. See [native loss evidence](../../../../tests/desk/mcp/__tests__/runtime/recovery_process_custody.test.js) and [main-worker recovery cycles](../../../../tests/desk/mcp/__tests__/runtime/worker_recovery.test.js).
# Existing-rebase admission

The recovery worker checks Git-derived `rebase-merge` and `rebase-apply` metadata
against its exact worktree admin directory before branch/upstream inspection.
An existing directory blocks synchronization as `rebase_in_progress`; an
invalid, unsafe, unreadable or expired observation blocks it as
`sync_operation_unverified`. Both reasons suppress dependent background boot
checks. The worker retains the operation and does not abort, continue, stash,
remove locks, dispatch delivery or file a new problem because of this refusal.

These are local metadata observations under the original worker deadline, not
exclusive custody. A writer can start a rebase after an absence check, and
synchronous filesystem IO is checked after return rather than forcibly
preempted. The guard does not repair conflict-marker files, stale index locks
or an already stalled operation.

## POSIX, non-Git archive integration

The first aggregate archive route uses the existing archive move session on
macOS/Linux, with no Git metadata in the effective person's ancestor chain.
Git, Windows and custom transports do not acquire aggregate custody through
this route. No installed-consumer, native Windows or Git recovery qualification
follows from the source fixtures.

Before any effect, the handler inventories original owners and referents inside
the effective person's root. Only type-qualified external `.git` and
`node_modules` directories are opaque storage boundaries; their entry identity,
mode and parent membership remain admitted, but their contents are not
traversed. Such storage inside the moved source is unsupported and refuses
before the marker or any other effect. Files, symlinks and other lookalikes
are not silently excluded. The handler computes one
immutable original/final map for outbound links, inbound links, structured track
rows, status, report fields and derived cells. Another person's tree is not read
or rewritten. Regular files require unaliased descriptors; directory referents
require their own descriptor, identity, mode and membership observation,
including the effective root itself for root-relative directory references. Missing,
ambiguous, unsafe or out-of-scope targets refuse rather than being repaired.
Completion claims additionally bind one original card observation: its
no-follow readonly descriptor, positional full-EOF bytes, name, version and
mode must agree before those bytes are parsed. Status/record, evidence and
derived assumptions come from that same version. Aggregate admission rejects
a later different card, including a card appearing in an originally absent
slot, before the marker or any write; it does not apply old evidence to a newly
observed baseline. Link discovery and planning use the same canonical full
Unicode label fold, so referenced outside non-Markdown files receive their
descriptor/byte/cap admission too.
Every operation-local refresh or preflight reread uses that same guarded
reader: canonical ancestor identities, original named type/version and the
FD generation are checked before allocating or reading replacement contents.
Same-card delegated-step lookup follows this path too. A symlink or enlarged
replacement is refused without reading its target. Known absence is checked
as absence, not by a content read. Qualified no-Git report/terminal lineage
uses the existing local-root/track/slug job format after renewing physical
no-Git admission, avoiding the legacy birth-history helper's same-card name
read; Git, Windows and custom legacy routes keep their existing reader path.
Successful original-card reads recheck the original mutation deadline after
their required descriptor close settles, before returning bytes for parsing
or evidence refresh. Late settlement never renews the budget or authorizes a
new peer/PR lookup. Earlier read errors retain precedence over a late or failed
close; an expired error path does not launch another observation merely to
replace that original failure.

This route intentionally admits at most 512 directories, 4096 entries, depth 16,
256 Markdown documents, 1 MiB per document, 16 MiB total Markdown, 64 MiB admitted
companion/target bytes, 64 changed owners, 8 MiB changed bytes and 4096 reference
records. Initial inventory and later membership checks use owned directory
readers with a one-entry internal buffer. They check the remaining inventory or
expected-member limit before retaining the next name and sort only bounded
collections. Reader acquisition, unknown reads, closure and late settlement
have their own evidence. Reads and writes stream in at most 64 KiB chunks. Its original mutation
deadline is 30 seconds from public handler entry; descriptor/evidence settlement
has an original 40-second cutoff. Neither clock renews during planning, waits,
parent creation, moving or replacement. Pending effects remain pending on expiry.
These intentional constraints do not activate the aggregate route for Git or
Windows. They are not an internal deadline or cancellation mechanism for legacy
or Factory APIs.

The first admitted effect exclusively creates the private
`.desk-archive-operation.json` marker. Its bytes are never parsed into authority:
any type at either selected source or destination is a negative compatibility
signal on every archive route. A new invocation cannot replay a partial move,
adopt its current files as an original map, refill a report or report
`already_archived` merely because the destination exists. An unavailable marker
observation is not absence. The selected root and directory generations are
renewed across waits; the default created-directory callback renews admission
after discovering missing parents, before making any path cleanup-eligible.
Legacy markdown helpers receive the same optional write guard after their own
asynchronous preparation, including fallback and cleanup boundaries. A guard
refusal cannot become a held-open fallback. The guarded atomic helper binds its
exclusive temporary descriptor before writing and retains unknown closure or a
foreign replacement instead of deleting it; earlier IO errors retain secondary
guard/cleanup evidence. Callers without this optional guard retain the existing
markdown writer behavior. This seam is not an aggregate grant for legacy routes.

Each replacement uses an exclusive read/write, no-follow stage, positional
offset-zero writes and an independent offset-zero, full-EOF read. The named
rename source and installed inode must match the previously owned stage inode;
equal bytes in another inode are not ownership. Fresh parent descriptors must
match their first post-mkdir named observation before joining the original
created-directory registry. The original marker inode follows the folder move
and is retired only after all Final checks and required descriptor closes.
Confirmed original-marker unlink and named absence immediately record the
known retirement and `final_complete` filesystem phase, with only its own
expected member removed in memory. Later directory/read/close/clock uncertainty
remains pending and cannot turn that known retirement into a phantom marker or
admit an unlink replay.
Partial counts, missing return values, failed closure and uncertain unlink
outcomes retain their actual evidence without replay or speculative cleanup.
An error after confirmed retirement retains the `final_complete` filesystem
phase; it does not invent unfinished file writes or emit delivery success.
After the final stage IO, the original target's held descriptor, name,
version, bytes and admitted parent are renewed again immediately before
replacement. A late edit is not overwritten and then hidden by installing the
stage as a new baseline.

Factory terminal work has a separate, deliberately nontransactional handoff.
Even `factoryStateRoot(create:false)` may repair private state. Each top-level
root/finalize/evaluation call gets a last marker/currentness/deadline gate and
an attempt record before dispatch, with root/job lineage, original time,
returned result or first error and separate post-await barrier evidence.
A marker already known at that gate admits no new call. A marker racing an
accepted call does **not** prevent that call's internal writes, mode repairs,
renames or cleanup. Those effects remain unknown/partial; the response is
`archive_pending`, preserves any `final_complete` filesystem phase, and admits
no next helper, task-originated retry, recall or removal. Ordinary unmarked
terminal work and its deferred-error behavior remain.

The Factory writer has no internal deadline/cancellation seam. A call accepted
before the archive deadline may return, fail or continue its own work after
the archive mutation/evidence cutoffs; the handoff does not invent cancellation,
finite internal closure or zero effects from a rejection. Its controls use the
actual protected outbox on fresh synthetic state, with a narrowly scoped,
explicitly synthetic ACL observation rather than a native ACL-provider proof.

These are optimistic currentness checks, not kernel compare-and-swap or
exclusion of nonparticipating editors. The final validation-to-syscall race,
including mkdir-to-first-observation, remains. An in-flight filesystem call
cannot be forcibly cancelled at the JavaScript deadline; its exact returned or
unknown effects and later descriptor settlement remain visible. There is no
persistent retry grant, marker age-based cleanup or claim that all writers
participate. See the [real no-Git and source failure controls](../../../../tests/desk/mcp/__tests__/tools/archive_link_aggregate.test.js).
