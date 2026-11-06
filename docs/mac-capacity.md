# Make room, not casualties

A field guide for an agent maintaining a shared Mac. Clear the crumbs, not
somebody else's dinner.

This is a method, not permission to delete anything. The operator's current task
owns the target, allowed cleanup, held resources and delivery boundary. Keep
machine paths, account names, job labels and private evidence in that desk;
[content routing](../plugins/desk/skills/content-routing/SKILL.md) owns that split.

## Start here: 30 seconds

1. Read the existing task and checkpoint. Keep the same duty; do not start a
   replacement cleaner, session or schedule.
2. Take a fresh measurement:

   ```sh
   date -u +%Y-%m-%dT%H:%M:%SZ
   df -k /System/Volumes/Data /System/Volumes/VM
   sysctl vm.swapusage
   ```

   `df -k` reports 1,024-byte blocks. Multiply **Available** by 1,024 for bytes;
   one GiB is 1,073,741,824 bytes. Compare against the task's actual target,
   not a remembered number. Source: the installed `man df`.
3. Pick one already-authorized, exact cleanup candidate and check its owner and
   consumers. If none is qualified, investigate a concrete lead rather than
   deleting a large-looking directory.

**A cleanup receipt is not a capacity result.** Measure again after the bounded
operation. The target is met only when actual available space meets it.

## First, find the kind of pressure

| Question | Light first check | Do not conclude |
|---|---|---|
| How much room is available now? | A timestamped `df -k` on the actual volume. | A previous successful cleanup still supplies that room. |
| Is swap changing with the disk? | Paired Data/VM readings and `sysctl vm.swapusage`. | A large swap total proves the main refill cause. |
| Which files are changing? | A finite metadata window on named roots, with a positive control. | Every changed file is disposable, or observed activity explains the whole disk. |
| Is a deleted file still open? | An exact, permitted holder check. | An absent pathname means its storage is released. |
| Are our helpers finished? | Check their shutdown result and exact process generation. | An exited parent means every child ended. |

Use one-shot `vm_stat` when memory detail is needed. Supplying an interval makes
it repeat; do not accidentally leave another observer running. Its manual also
points to `meminfo` on systems that provide it. Source: the installed `man vm_stat`.
Never use a memory-pressure generator as a diagnostic query: the installed
`man memory_pressure` documents options that deliberately allocate memory.

Swap, file activity and available space are different signals. Compare the same
time window before making a cause claim. If free space falls while VM allocation
is unchanged or smaller, VM growth does not explain that window's loss. That
still does not identify the writer or explain earlier history.

## The cleanup gate

Age is a filter, not permission. "Archived", "idle", "cache", "temporary" and
"parent PID 1" are leads, not proof that something is unused.

Before an effect, establish all of these for the exact target:

- **Authority:** this category and action are allowed; explicit holds still win.
- **Ownership:** the resolved path, owner, device, type and flags match the
  admitted object. Do not follow an unexpected link or cross into another user's
  data.
- **Value:** no unique source, local-only work, required evidence, credential,
  installed/shared tool or retained consumer depends on it.
- **Release:** current holder, reference and alias checks permit removal. A
  quiet process snapshot is not the whole dependency check.
- **Generation:** the complete saved qualification still matches immediately
  before the effect. Persist comparison maps before comparing them.
- **Effect:** the supported tool acknowledges this exact item; then verify the
  intended absence and preservation of non-targets.

Use the provider's supported cleanup or lifecycle operation where possible.
Do not treat deletion through a different transport as a way around an approval,
ownership or preservation gate.

For Trash, consume the operator's explicit authority, inspect exact new entries,
and keep the Trash root. A discarded tree can still have a live consumer.
Moving something into Trash alone is not a free-space recovery.

Compression, deduplication and moving data elsewhere are separate operations,
not harmless substitutes when deletion is refused. Each needs its own authority,
preservation checks and resource budget.

For byte-preserving sharing of nearly identical files, similarity is only a
discovery signal. Reconstruct the original bytes in private staging, verify the
complete original checksum and supported metadata, then use a journaled atomic
exchange with adoption checks and rollback. Preserve quarantine verbatim; never
strip it to make copying work. Treat a database and any sidecars as one
preservation surface: do not open, checkpoint or discard a journal to force a
cleanup gate. If any consumer, generation or reference changes, retain the data
and reconcile before a fresh admission.

## Account in bytes, not wishes

Keep these numbers separate:

| Number | What it tells you |
|---|---|
| Directory or file allocation | A place to investigate, not a safe disposal budget. |
| A tool's reported freed bytes | What that tool acknowledged, not an isolated change in physical free space. |
| Observed file-write activity | Activity inside that window and scope, not necessarily net new allocation. |
| Actual available bytes | The capacity boundary the task must meet. |

Do not add directory totals as though shared or cloned storage were independent.
Likewise, concurrent writers mean a before/after free-space delta is not a clean
measurement of your operation alone.

For a file-event trace, save its scope and limits. A positive control proves that
the observer saw that control, not that coverage was complete. Dropped events,
failed paths, bounded-map exhaustion and timeouts must remain visible. First
observation is not the window's starting allocation; deleted paths and shared
extents need separate accounting. Do not convert an incomplete probe into zero.

## Keep the janitor small

The janitor cleans; it does not conduct the orchestra.

- Use ordinary file-in-use checks, not other agents' conversations or queues.
  Leave source, held builds and active browser resources alone.
- Do not stop or steer workers to make a cleanup gate pass. Process cleanup is
  limited to resources whose exact ownership and generation you can establish.
- Prefer a narrow read to a whole-machine walk. Stop an unchanged refused
  candidate; revisit it only when material evidence changes.
- Keep measurements light during shared-machine load or a declared build window.
  Do not benchmark, install tools or repeatedly start helper hosts as a proxy for
  space recovery.
- Inspect the documented shutdown result of helpers you actually need. Awaiting
  a method is not enough if its contract returns cleanup errors.

[Evidence discipline](../plugins/desk/skills/evidence-discipline/SKILL.md) owns
claims, process ownership and verification.
[Session resumption](../plugins/desk/skills/session-resumption/SKILL.md) owns
checkpoint admission and uncertain-effect recovery.

## Reuse the maintenance already there

The private task records the actual launchd labels, installed entrypoints,
intervals, scope and recovery path. Read those before changing anything.
`launchctl print` can show an existing service's current state and last exit;
its manual explicitly warns that the output is **not a stable API**.
Source: the installed `man launchctl`.

A registered job, a zero historical exit, a coalition marked active or a displayed
next-run time is not proof of future execution. Keep read-only sampling distinct
from bounded cleanup. Exercise the inner cleanup once successfully before
relying on a recurring mechanism. Do not add a model polling loop.

## Leave a small, honest handoff

Update the existing canonical task and checkpoint with:

- the timestamp, actual available bytes, current target and whether it is met;
- exact completed operations, acknowledgements and preservation evidence;
- retained candidates and the real gate, not a guessed explanation;
- uncertain effects and their operation identities, without blind retries;
- exact own resources still running, their stop/recovery path, and the next
  concrete step.

Keep the duty open when the target is unmet. Name a real preservation or
permission blocker when it prevents delivery; do not quietly lower the target.
Once the target is met, retain any standing monitoring until its owner relieves
it. Do not describe a locally saved checkpoint as committed, pushed or backed up
elsewhere.
