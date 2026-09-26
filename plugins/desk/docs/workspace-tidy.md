# Workspace tidy and close-out

Every task, iteration and delegated-assignment owner closes out its own resources. [Git hygiene](../skills/git-hygiene/SKILL.md#exact-owned-cleanup) supplies the exact-owner and live-writer gates; [task lifecycle](../skills/task-lifecycle/SKILL.md#close-out-at-every-ownership-boundary) supplies the child return inventory and canonical Resources table. The [Desk adapter](../skills/using-superpowers-with-desk/SKILL.md#mapped-controller-close-out) maps per-task controller cleanup onto pristine Superpowers, including the sequential fallback. A PR-only or alpha endpoint retains its worktree and refs until the recorded cleanup trigger.

## Startup

Both [Claude](../hooks/session-start.sh) and [Copilot](../hooks/copilot-session-start.cjs) call [boot-checks.cjs](../hooks/boot-checks.cjs). The `workspace-tidy` check reads the bound desk's task cards and runs only Git metadata/worktree listings. Its [inventory](../mcp/src/runtime/workspace-tidy.js) has a 200 ms deadline and limits of 128 current cards, 512 directories, 4,096 directory entries, 16 repositories and 128 linked worktrees; the whole check has a 500 ms deadline, including report reads and dispatch. It includes non-terminal tasks and tasks finished within 30 days, including archived tasks/tracks and crew desks; a missing terminal date is included conservatively. It never scans the home folder for repositories, follows task-directory symlinks, enters a task's code/evidence folders, or fetches at startup. Ordinary block-list `repos` and `repos: []` are supported without installed YAML dependencies; unsupported or unreadable metadata makes the inventory incomplete and prevents removal.

The inventory preserves repository-level indentation, including nested `paths` lists and long folded `local_path` scalars produced by [Desk's serializer](../mcp/src/util/fm.js). Any `task.md` entry establishes a boundary: a symlink or unreadable card defers inspection, never opens traversal into that task's code/evidence. Deadline cancellation reaches [the exact owned Git subprocess](../mcp/src/runtime/git-inspection.js); the runner waits for its process and pipes to close, rather than merely returning a budget message while the host still waits. This cancellation terminates only a check-owned inspection child, never a task writer.

The hook starts one detached repair and returns a bounded `Desk boot:` line addressed to the agent, not the human. It reports the previous completed repair, when available, plus the newly deferred listing. On the first run safety classification is pending, not a claim of successful cleanup. Detailed current results are written after the hook returns. Copilot's ambiguous overlay binding defers without launching against a guessed desk: use the root from `desk_status` for an explicit repair. [Executable host and deadline tests](../mcp/__tests__/runtime/workspace_tidy_boot.test.js) cover the startup connection.

```text
Desk boot: workspace-tidy Last repair: Tidied 3 stale worktrees; 1 left: /work/topic: local commits not preserved at delivery; deferred (1 listed)
```

The [repair](../hooks/boot-checks.cjs) writes a mode-0600 `desk-workspace-tidy-<root-hash>.json` under the bound desk's common Git directory, outside the tracked tree. The report keeps every removed resource and unsafe leftover; a long one-line summary groups identical reasons and preserves the total leftover count. Its sibling `.lock` serializes repairs for this bound root. An existing lock is never stolen by age or PID guess: reconcile its owner before removing the exact lock. This report is machine-local execution evidence; copy verified results into the task's canonical Resources table, never treat the report itself as task completion.

The report's [per-resource accounting outbox](../mcp/src/runtime/workspace-evidence.js) survives later scans. A pending receipt is flushed before removal; final dispositions, retained branch-only resources and other unsafe observations remain until the canonical accountant acknowledges that resource's exact `id` and `digest`. The line's removed count covers unacknowledged dispositions, not only this run. Version-one report evidence is retained rather than overwritten. After recording the disposition in canonical Resources, use `--ack <bound-desk-root> <id> <digest> <canonical-evidence-pointer>` on the same entry point. A stale digest or missing evidence pointer refuses acknowledgement; one acknowledgement never drains another resource.

To run the same deferred repair explicitly after resolving a binding ambiguity, use the installed plugin's entry point with the **actual bound root**:

```sh
node <installed-desk>/hooks/boot-checks.cjs --repair <bound-desk-root>
```

## Exact-owner release receipt

A listed repository is discovery scope, not removal authority. By default, an old worktree has no executable release receipt and is reported, not removed. The owner can prepare `desk-closeout.json` in that worktree's Git administrative directory (`git -C <owned-worktree> rev-parse --absolute-git-dir`) after reconciling the canonical Resources record and the owning host's exact generation/descendant evidence. This small machine-local receipt is an execution aid, not task frontmatter or a universal lifecycle schema. All fields below are required except `remote`; [the implementation](../mcp/src/runtime/workspace-tidy.js) rechecks them at removal.

```json
{
  "version": 2,
  "task": "track/task/task.md",
  "owner": "task/iteration/attempt",
  "disposition": "remove",
  "repository": "/absolute/repository/.git",
  "worktree": "/absolute/owned-worktree",
  "branch": "refs/heads/exact-task-branch",
  "head": "<released-full-commit-id>",
  "base": "refs/remotes/origin/main",
  "delivered": "<verified-delivery-commit-id>",
  "identity": { "dev": 0, "ino": 0 },
  "release": {
    "complete": true,
    "host": "<owning-host>",
    "machine": "<local-hostname>",
    "evidence": "<protected-host-operation-receipt>",
    "consumers": [],
    "processes": [{ "pid": 123, "start": "<Desk process-start identity>" }]
  },
  "remote": { "name": "origin", "branch": "refs/heads/exact-task-branch", "endpoint": "https://github.com/owner/delivery-repository.git" }
}
```

Use actual canonical paths, `stat` device/inode values, full commit IDs and `readProcessStart` identities from [Desk's process reader](../mcp/src/readiness/process-start.js), not the example values. `task` is relative to the bound desk and must name an inventoried card that records this repository. `delivered` is the commit whose destination content the owner already verified, and must still be on `base`. The release must account for **every** generation and owned descendant, not only the root PID; all remote writers and other consumers must have a verified release before `consumers` can be empty. Never mark unknown or unobservable writers complete. A host unable to provide this evidence leaves the worktree report-only.

Version 2 is an exclusive handoff coordinated by [exact-resource claims](../mcp/src/runtime/workspace-claim.js). Creating/changing a release receipt and any revocation/reacquisition must use `withWorkspaceClaim({repository, worktree, branch, owner}, action)`. It claims both the exact branch and worktree path under their common Git directory, independent of which bound desk starts cleanup. The claim survives worktree administrative-directory removal and is held through mutation, absence readback and disposition persistence. Version 1 receipts are report-only because their revocation protocol was not coordinated.

Do not unlink the receipt directly or resume a consumer while cleanup owns the claim. Use `node <installed-desk>/hooks/boot-checks.cjs --revoke <common-git-dir> <worktree> <branch-ref> <owner>` (or `revokeWorkspaceRelease` from the runtime); only a successful revocation authorizes reacquiring the task reservation and attaching a consumer. A busy, changed or unobservable claim refuses the operation; it is never stolen by age. This is a coordination protocol, not an OS security boundary against a person bypassing it. Never emit `disposition: "remove"` for a deliberately retained alpha, open PR, unmerged experiment or unacknowledged transfer. The repair checks process-generation identity and refuses live or unobservable task writers; it never terminates them. [Refusal and race fixtures](../mcp/__tests__/runtime/workspace_tidy.test.js) exercise the boundary.

## Removal conditions

The [repair](../mcp/src/runtime/workspace-tidy.js) requires a complete inventory, matching repository/path/branch/HEAD and filesystem identity, an unchanged task card and release receipt, released writers/consumers, no checkout protection, no worktree lock, no Git operation and no tracked, untracked or ignored files to preserve. It refuses `assume-unchanged`, `skip-worktree` and other index states that prevent reliable tracked-byte inspection, even when ordinary status is empty. It rereads those conditions under the claim immediately before non-forced `git worktree remove`, then reads back both path and registration absence. The primary checkout and bound desk are never removal targets. It does not switch any checkout; safe state-branch restoration remains the close-out owner's responsibility.

An ancestry-merged branch is eligible. For a squash delivery, matching delivered content on the base **and** a successful `ls-remote --exit-code --refs` showing the exact recorded delivery ref absent are required. The receipt binds the normalized **push** endpoint, not a mutable remote nickname or its fetch URL. `remote get-url --push --all` must resolve to exactly one endpoint matching the receipt; changed mappings, multiple push URLs, credential-bearing URLs and missing endpoint proof refuse cleanup. The query names that endpoint directly and verifies with `ls-remote --get-url` that URL rewriting would not redirect the query elsewhere. HTTPS, SSH/scp-style and canonical local/file endpoints are supported; use `normalizeDeliveryEndpoint` to record the value. A missing remote-tracking ref is not evidence, and lookup runs only in the detached repair.

A deleted remote never authorizes loss of local-only content. Only ancestry-merged local branches are deleted, under the exact-resource claim, after checking they are not attached to another worktree. `git update-ref --no-deref -d <ref> <released-head>` performs the expected-HEAD comparison atomically; it never deletes a changed ref or follows a symbolic ref to another branch. A squash branch remains named for its owner to reconcile. Remote branch deletion remains the owner's source-system delivery step. No branch-name heuristic, forced worktree removal, broad prune, reset or process-name cleanup exists.
