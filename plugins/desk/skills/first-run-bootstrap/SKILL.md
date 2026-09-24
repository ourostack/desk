---
name: first-run-bootstrap
description: Bootstrap a new Desk or upgrade an existing V1 Desk in place. Fresh bootstrap may discover, clone, create, bind, or skip a workspace; V1 upgrade preserves the existing workspace and durable state, records rollback evidence, replaces declarations with the reviewed V2 chain, verifies readiness, and resumes work.
---

# First-run bootstrap

Use this skill when the startup hook or `session-start` routes into Path 1. Consumer overlays may supply identity, repository naming, richer templates, and private activation details, but they must preserve the two branch boundaries below.

## Path 1 — start or upgrade a Desk

Choose exactly one entrance from current workspace evidence. Entrance A owns fresh bootstrap choices. Entrance B owns in-place V1 migration and must not execute any fresh-bootstrap choice. Both converge on one readiness and first-job endpoint without forking durable work.

### Entrance A — new to Desk

Use this entrance when no desk is bound: the startup hook says so, or `desk_status` reports setup mode. If `desk_status` names a different `onboarding_skill` — an overlay that owns its workspace, such as a crew's `crew:join-crew` — follow that path instead; it owns discovery and binding for that workspace. Desk stays running in setup mode throughout; never end onboarding by leaving Desk unavailable. Look first, then ask once with what you found.

#### A1. Look for a desk that already exists, locally

Many operators already have a desk clone that simply is not bound. A desk has `_meta/` plus `_archive/` (solo) or `desks/` (crew). Check the paths `desk_status` already tried, then scan the usual places without writing anything. This works in both bash and zsh; a glob loop does not, because zsh aborts on a pattern that matches nothing:

```bash
find ~ ~/code ~/Projects ~/src ~/dev ~/repos ~/github -maxdepth 2 -type d -name _meta 2>/dev/null | while read -r m; do d=$(dirname "$m"); { [ -d "$d/_archive" ] || [ -d "$d/desks" ]; } && echo "$d $(git -C "$d" remote get-url origin 2>/dev/null)"; done | sort -u
```

Also include the current project directory when it has the desk shape.

#### A2. Run remote discovery

Run `gh auth status` before any remote call. If it is unhealthy, give the concrete repair (`gh auth login`), keep any local findings, and do not create a fresh desk while a remote one might exist — that forks the operator's history.

With healthy auth, find the operator's desk repository: probe any overlay-supplied expected remote first, then `gh api user --jq .login`, then `gh repo view <login>/desk`, then `gh repo list <login> --limit 200 --json nameWithOwner,description,pushedAt` and keep repositories whose name or description mentions desk. Match remote results against local clones from A1 so one desk is not offered twice.

#### A3. Ask once

Present one decision group listing what you actually found, most likely first:

- use the local desk found at a path from A1;
- clone or fresh-create: clone the remote desk found in A2 (default destination `~/desk`), or create a fresh desk repository;
- use an operator-provided path or URL;
- skip workspace persistence for this session.

If nothing was found, lead with creating a fresh desk. Never offer "continue without Desk" as an option here.

#### A4. Execute the choice

- **Local desk:** bind it in place; do not copy or move it.
- **Clone:** clone with the authenticated remote into the chosen path, then verify origin and the desk shape.
- **Fresh-create:** create `_archive/`, `_meta/`, a `.gitignore` containing `.state/`, and a short README; initialize Git and commit. Offer to create the remote with `gh repo create <owner>/desk --private --source <path> --push`, asking for owner and visibility rather than choosing them silently.
- **Operator-provided path or URL:** bind an existing path without copying it; clone a URL.
- **Skip:** warn that task lifecycle, recall, resumption, friction and lesson persistence are unavailable for this session, and offer bootstrap again next session.

#### A5. Bind, activate and verify V2

Make the binding survive new sessions and plugin updates:

- **Claude Code:** write `{"schema_version": 1, "desk": {"root": "<absolute desk path>"}}` to the `binding_path` that `desk_status` reports (`$CLAUDE_PLUGIN_DATA/desk.activation.json`). Opening the desk folder itself as the project also binds it.
- **Codex:** use the activation adapter through `desk:codex-onboarding`.
- **Other hosts:** set `DESK` in the host's environment.

MCP servers resolve the desk when a session starts, so ask the operator to start a new session. In it, `desk_status` must report the chosen root and its source, and `desk:session-start` runs normally. Declare and activate the reviewed V2 plugin chain supplied by the selected runtime or overlay, verify the selected roots, confirm admitted MCPs and startup foundations are available, and route to the first real job.

### Entrance B — existing V1 Desk

Use this entrance only when the Desk workspace already exists and current evidence shows V1 declarations or missing V2 startup foundations. This branch is an in-place migration of that existing workspace.

1. Detect and inventory the existing workspace and Git state, durable task state, active V1 declarations, installed or linked capabilities, selected runtime roots, MCP configuration, startup surfaces, ignored files, and untracked files.
2. Record rollback evidence before mutation: capture the current commit or other rollback ref, origin and branch relationship, status and inventory, active declarations, and any machine-local bindings needed to restore the pre-migration state.
3. Preserve the same workspace, Git history, durable records, task identity, and local path throughout the migration.
4. Replace V1 declarations with the reviewed V2 chain for the selected runtime or overlay; remove superseded declarations rather than layering a second active chain beside them.
5. Reconcile retired V1-only capabilities by mapping them to reviewed V2 owners, removing them when obsolete, or explicitly retaining them with a recorded reason and authority boundary.
6. Activate and verify V2 by loading the selected roots, proving the active plugin chain, confirming admitted Desk MCP readiness, checking startup readiness and foundation presence, and verifying that the existing durable state remains readable.
7. Resume the existing task or start the first V2 job in that workspace, recording migration evidence on the same durable work record when one already exists.

Entrance B must never route into Entrance A choices or initialize over the existing V1 workspace.

### Converged endpoint

Both entrances end at one Desk, one active plugin chain, admitted MCPs, startup foundations present, and the operator ready to resume or start the first real job from the same durable workspace. Later healthy sessions resume through ordinary `session-start` flow instead of replaying onboarding.

The public RFC stays optional and on demand. Use it when the operator wants design context; do not require healthy startup or resumption to reread it.

## Completion evidence

Record which entrance ran, the source and destination state, the active V2 roots and declarations, MCP and startup readiness, the durable task resumed or first job started, and any explicitly retained legacy capability. For Entrance B, include the rollback ref and pre-migration inventory.

## Cross-references

- `desk:session-start` owns routing, normal sync, task discovery, and resumption.
- `desk:session-start-migrations` owns machine-local stale-path repair before path-dependent scans.
- `desk:directory-structure` owns the canonical Desk layout.
- `desk:start-task` owns creation of a new durable task.
