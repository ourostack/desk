---
name: first-run-bootstrap
description: Bootstrap a new Desk or upgrade an existing V1 Desk in place. Fresh bootstrap may discover, clone, create, bind, or skip a workspace; V1 upgrade preserves the existing workspace and durable state, records rollback evidence, replaces declarations with the reviewed V2 chain, verifies readiness, and resumes work.
---

# First-run bootstrap

Use this skill only when `session-start` routes into Path 1. Consumer overlays may supply identity, repository naming, richer templates, and private activation details, but they must preserve the two branch boundaries below.

## Path 1 — start or upgrade a Desk

Choose exactly one entrance from current workspace evidence. Entrance A owns fresh bootstrap choices. Entrance B owns in-place V1 migration and must not execute any fresh-bootstrap choice. Both converge on one readiness and first-job endpoint without forking durable work.

### Entrance A — new to Desk

Use this entrance only when no Desk workspace exists at the selected path.

#### A1. Gate remote discovery on authentication

Run `gh auth status` before filesystem writes. If authentication is unhealthy, stop with the concrete repair; do not create a local orphan that could fork an existing remote Desk.

#### A2. Run remote discovery

Probe the overlay-supplied expected remote. If it exists, offer one clone into `$DESK/`. If no remote exists or the operator declines it, offer only these fresh-bootstrap choices: clone or fresh-create, use an operator-provided path or URL, or skip workspace persistence for this session.

#### A3. Execute the selected fresh bootstrap

For clone, use the authenticated remote and verify origin plus expected Desk shape. For fresh-create, create the minimal `_archive/`, `_meta/`, `.gitignore`, and README scaffold, initialize Git, and offer remote creation without silently choosing visibility or owner. For an operator-provided path, bind or symlink the existing local path without copying it; for a URL, clone it into `$DESK/`. For skip, warn that task lifecycle, recall, resumption, friction, and lesson persistence are unavailable or degraded.

#### A4. Activate and verify V2

Declare and activate the reviewed V2 plugin chain supplied by the selected runtime or overlay, verify the selected roots, confirm admitted MCPs and startup foundations are available, and route to the first real job.

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
