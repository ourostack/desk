# Desk black-box tester

## Optional #581 failure observations

The default is unchanged. Only the exact output controls `CI=true`,
`GITHUB_ACTIONS=true` and `DESK_BLACKBOX_NATIVE_RECEIPT_TRACE=1` together enable
the diagnostic. They do not authenticate CI or authorize native work. Only the
measured desk-server launch receives the three controls; the isolated person
environment, hooks, desk-web and existing warmup do not inherit them.

On `task_archive` exceptions, a descriptor-only, Proxy-rejecting projector
selects bounded structural observations from the existing receipt. These are
untrusted data, not a local brand, native admission, OS closure or execution
proof. Ordinary MCP answers and error messages remain unchanged. The new
projection never invokes getters, coercion, iterators, `toJSON` or `cause`;
this guarantee does not change the normal error serializer's existing behavior.

The stderr codec is `DESK_NATIVE_RECEIPT_V1 ` followed by one bounded JSON frame.
The client reprojects it, binds numeric RPC IDs at dispatch to source-owned
host/repeat/case/desk-instance context, and preserves bounded completed bindings
for late frames. Evicted or unscoped frames remain unmatched, never attributed
to the currently running check. There are no additional waits or retries.
Only failed-case observations enter `native_receipt_trace` in the existing
`--out` JSON: at most 64 KiB per case and 1 MiB across the job, including
correlation/framing and reserved status space. Missing fields/times/counts stay
unknown; counters and per-case truncation record incomplete collection.
With this explicit diagnostic opt-in only, the JSON artifact uses compact
serialization; default-off JSON retains its existing two-space indentation.
The same serializer accounts admission and writes the artifact. Budgets charge
actual UTF-8 record/case metadata and array separators, with a schema-derived
maximum counter/source envelope; no accumulating job is built to measure an
admission. Counter growth and source identity therefore cannot exceed the job
cap after observations have been retained. JSON values, checks and Markdown
are unchanged by the opt-in formatting difference.
No new raw stderr, paths, environment values, payloads, PID/handles or tokens
are retained. `native_receipt_source` separately records fixed source hashes,
HEAD and a nullable dirty indicator, not raw Git status. Markdown and normal
checks/summary/verdicts are unchanged.

The temporary nonrequired `Desk native receipt diagnostic 581` workflow was
consumed on PR580 at commit `7318a47a23040b416cb6e9958739641fe99084b2`
([run 41549295986](https://github.com/ourostack/desk/actions/runs/41549295986)).
That head observation is distinct from the ordinary CI merge checkout.
The route is now retired: removing the workflow restores scheduled-refresh
gate discovery and avoids cumulative repeat diagnostic jobs. The published
commit, run and collected evidence are not rewritten by retirement.

Default-off instrumentation remains; a future diagnostic needs a separately
reviewed route and operation admission consistent with the maintained CI
contract. Output controls alone grant no execution authority. The fixed source
identity slot for the retired workflow is explicitly `null`, not a fabricated
hash. Required jobs, their names and the scheduled dispatch list are unchanged.

An all-pass error-only trace establishes no successful native stage timeline.
Historical failures, root cause and normal required CI gates remain separate.

## Optional #581 native stage diagnostic

Adding `DESK_BLACKBOX_NATIVE_STAGE_TRACE=1` to the receipt-trace controls (all four of `CI`, `GITHUB_ACTIONS`,
`DESK_BLACKBOX_NATIVE_RECEIPT_TRACE`, `DESK_BLACKBOX_NATIVE_STAGE_TRACE` must be exactly present) makes the measured
Desk server run a separate PowerShell variant: the default program plus five `DESK_STAGE <stage> <pid> <microseconds>`
lines (`start`, `compiled`, `verified`, `request_read`, `baseline_done`). The default program, its pinned hash,
protocol, deadlines and outputs are untouched when the control is absent. The receipt records `programVariant` and
`executedProgramSha256` (the hash of the bytes actually executed, distinct from the pinned default `programSha256`).

Reading the data: `nativeUs` is child-relative (Stopwatch since the script started running); `wrapperUs` is Node's
clock since spawn. Their first difference is a launch-plus-initial-delivery composite, not a launch time; later
differences between `wrapperUs` and `nativeUs` intervals can show differential delivery lag. `start`..`compiled`
covers the Reflection.Emit compile plus the script's own setup; `compiled`..`verified` covers metadata verification and the
layout check; `verified`..`request_read` also includes waiting for and parsing the request; `request_read`..`baseline_done`
is the baseline read. Markers are delivered through the parent, so a parent stall can delay delivery of a marker: a
prefix of markers shows how far the child got as observed, and cannot alone prove the underlying cause of a slow
stage. A failure with no markers is censored: it does not identify cold
launch or any other cause. The variant is not byte-identical to production, the marker cost is unmeasured, and the
data shows where time went, not why. The opt-in open also refuses a `captured` line unless all five markers arrived
first in order. Passed cases keep their records under the same 64 KiB per case and 1 MiB per
job caps; case outcome is joined from the run results by host, repeat and case id. `native-stage-context.js` (the gate and
request scope) is pinned in the artifact's source provenance with the other executed files.

Run `node tests/blackbox/run.mjs` from the repository root with Node 22 or later and Git on `PATH`; it needs no `npm install`. It copies the shipped `plugins/desk`, `superpowers`, `plain-language` and `crew` folders into a throwaway home laid out the way Copilot and Claude Code install them, builds a small Git desk with a local bare remote, and then, for each host, runs that host's hooks from its hook manifest, starts the `desk` and `desk-web` MCP servers from its MCP config and the boot script, and checks every Desk tool, search, Git commits and pushes, plain error messages and the browser. It never imports Desk's source, so a refactor that keeps behavior passes. It fails on any broken check or any place Copilot does worse than Claude Code (fewer tools, skills or agents, a weaker hook result, more failures, or clearly slower, judged only when each host has at least five samples of that timing; with fewer, as CI's `--repeat 2`, a slower speed is shown as informational), and writes `blackbox-<label>.json` and `.md` (timings as p50 and p95, server cold start, boot time, peak memory, time to the first meaning-based recall, pass and fail counts) to `--out` (default: the OS temp folder). Useful flags: `--repeat N` reruns everything N times to find flakes, `--hosts copilot` or `--hosts claude` runs one host, `--no-browser` skips the browser, `--mine` also opens a copy of your own browser profile (local only), `--cache-dir <dir>` keeps the downloaded search model and browser driver between runs (`--no-cache` measures a true first run), and `--keep` leaves the temp folder for inspection. A check that fails on `main` because of a real bug goes in `KNOWN` in `run.mjs` with its reason, never by loosening the check. `node tests/blackbox/real-hosts.mjs` is the separate end-to-end layer: it runs a few real `agency copilot` and `claude -p` sessions on this machine and is not run in CI. `--scenario progress-note` runs one session that records a progress note with `task_update` on a desk whose pre-commit hook is slower than Desk's 10 s card-commit budget; it passes only when the note reaches the remote. `--plugin local:<folder>` runs Copilot with that Desk folder instead of the installed one, so a branch's own Desk is what the session uses.
