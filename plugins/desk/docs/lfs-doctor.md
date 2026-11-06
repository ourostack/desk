# Request local storage observations

Use `desk_doctor` with `{"storage":"inspect"}` to add local binary-storage observations to the ordinary runtime diagnosis. This is explicit and read-only; it does not install, convert, download, upload or repair anything. Default doctor calls remain unchanged and synchronous. Startup and `desk_status` do not start this inspection. [Doctor consumer](../mcp/src/tools/doctor.js), [advertised input](../mcp/src/tool-schemas.js).

**Preview takes precedence.** `{"format":"preview","storage":"inspect"}` returns only the unchanged preview snapshot and starts no storage worker. Unsupported storage actions on a full request are rejected before storage inspection. A full storage request cannot include `repair`; the session dispatcher rejects that combination before its named state-branch repair runs. Default repairs keep their existing behavior. [Preview and direct input contracts](../../../tests/desk/mcp/__tests__/tools/doctor_storage.test.js), [session entry-path contracts](../../../tests/desk/mcp/__tests__/runtime/desk_session.test.js).

## Read the two health scopes separately

The existing `status`, `mode`, `reason`, `runtime`, organization and factory fields retain their existing meaning. In particular, `mode: "healthy"` describes MCP runtime health, not LFS readiness. The opt-in `storage` section always reports `readiness: "not_checked"` and keeps remote publication, network authentication and installed-payload qualification as `not_checked`, even when local bytes match every inspected pointer. [Result shaping](../mcp/src/tools/doctor.js).

| Storage field | Meaning |
| --- | --- |
| `state` | The local inspection's state, or an explicit unavailable, cancelled or not-checked outcome. It is not a storage-health verdict. |
| `worker` | `exited` confirms the owned actor ended; `not_started` means no actor was created for this request. A running or unconfirmed prior actor prevents another inspection of that bound root. |
| `scope` | Context/package classification only, without package-root or member-file paths. |
| `tool` | LFS executable availability only, not transfer or compatibility qualification. |
| `counts` | Local candidates, pointers, materialized-byte matches, missing cache objects, mismatches and diagnostic counts. No file names, object IDs, hook/filter commands or raw errors. |
| `next_step` | An exact permitted read-only action, or no action after cancellation. A command uses the current runtime's Node executable, the loaded package's CLI and the bound root, not a guessed PATH executable or caller-supplied repository override. |

The exact CLI command identifies its already-bound root and installed script, so the full report is local diagnostic data, not an upload-safe artifact. Preview includes none of it. The CLI's fuller report may identify files; keep it local and review it before proposing any separately authorized mutation. [Local inspector contract](lfs-inspection.md).

## Source, lifetime and budget

The session dispatcher forwards the explicit action, its admitted root and the request's cancellation signal to the runtime handler. With no available admitted runtime, it reports storage as not checked and starts no worker. The consumer runs the same dependency-free inspector in a fresh worker, following Desk's worker-thread convention without importing the server or native addons. It accepts a result only after a valid, root-bound reply and a clean worker exit. A reply alone, an early exit, an error, a malformed report or a result from another root never becomes an observation success. [Session dispatcher](../mcp/src/runtime/desk-session.js), [observation worker](../mcp/src/runtime/lfs-observation.js), [existing admission-worker convention](../mcp/src/runtime/admission-worker.js).

The bound Desk must be the Git worktree root. A nested directory is refused before the inspector inventories the wider repository. Missing or blank roots do not fall back to cwd, another desk or an environment-selected repository. [Binding regressions](../../../tests/desk/mcp/__tests__/tools/doctor_storage.test.js).

The worker has an 11-second work allowance and a further 4-second shutdown allowance; the inspector keeps its own smaller byte/path/process budgets. Cancellation requests terminate the owned thread and return a cancelled observation only after exit. A whole-budget expiry without exit confirmation reports `worker_stop_unconfirmed`, discards any reply, retains ownership of that actor and blocks repeated inspection of the same root until its exit is observed. No result cache or background service is created. These are execution budgets, not hard real-time guarantees for operating-system scheduling. [Lifecycle and budget implementation](../mcp/src/runtime/lfs-observation.js).

The focused tests exercise real worker cancellation and timeouts, status responding while an inspection worker is blocked, preview/default compatibility, root mismatch, private-error redaction, no-effect repository snapshots and failure/exit ordering. This source evidence does not qualify native Windows, remote LFS service access, plugin acquisition or the whole binary-storage setup flow. [Executable contracts](../../../tests/desk/mcp/__tests__/tools/doctor_storage.test.js).
