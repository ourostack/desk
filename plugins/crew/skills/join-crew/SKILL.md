---
name: join-crew
description: Migrate a legacy Crew repository in place before existing-member activation, or join a new member to a current V2 Crew workspace. Preserve repository identity, history, member state, shared records, authority boundaries, and conflict-safe shared writes; never create a parallel migration repository.
---

# Join a crew workspace

Bring an operator into a shared workspace without asking them to perform work the agent can do. This skill owns the vendor-neutral flow. An overlay supplies identity, authentication, transport, default alias policy, target path, and private dependency details. Read `desk:first-run-bootstrap` and `crew:shared-desk-conventions` first.

## Path 2 — migrate the Crew workspace, then activate members

Resolve the local workspace before choosing a member flow. An existing legacy repository must complete Phase 1 in place. A repository proven current V2 may skip migration and continue to sync. Remote discovery is only for a workspace that is not already present locally.

### Phase 1 — repository migration

Run this executable branch in the existing repository path before member activation.

1. Detect legacy layout and repository identity by proving the current path, Git worktree root, origin, branch and commit, committed registry, legacy Crew-v1 declarations or directories, and the evidence that the workspace is not yet current V2. Only a workspace proven to be current V2 may skip this migration and continue to ordinary sync.
2. Inventory repository state by recording tracked, ignored, and untracked state, member-specific subtrees, durable local state, `_meta/desks.md`, current dependency declarations, active tooling, machine-local bindings, and shared-path contents.
3. Record rollback evidence by capturing the current commit or other rollback ref, origin, branch relationship, full status and inventory, legacy declarations, and restoration instructions before mutation.
4. Reconcile the V2 layout in place by creating or reconciling every required `desks/<alias>/` subtree plus `_shared/landscape/` and `_shared/decisions/`, preserving Git history, origin, committed registry, durable state, ignored and untracked inventory, and every existing member's content.
5. Reconcile V1-only machinery by mapping it to a reviewed V2 owner, removing it when obsolete, or explicitly retaining it with a recorded reason, dependency, and authority boundary.
6. Declare the reviewed V2 dependency chain for Crew and its selected overlay without leaving a second active legacy chain.
7. Verify preservation and authority by proving repository identity, Git history, origin, tracked and local state, registry bindings, each member subtree, Crew read-across/write-own, and conflict-safe shared writes to `_shared/landscape/`, `_shared/decisions/`, and other serialized shared paths.
8. Mark repository migration complete in durable repository evidence only after every preservation, dependency, authority, and write-safety check passes.
9. Continue directly to existing-member activation against this migrated repository; do not enter remote or workspace discovery and do not create a duplicate or parallel Crew repository.

### Phase 2 — existing member activation

Read the committed `_meta/desks.md` registry, resolve the authenticated identity to exactly one existing alias, bind the specialist worker to this same repository with `--person <alias>`, verify repo-wide reads and writes rooted under `desks/<alias>/`, load declared tooling and repository context, and continue the existing member's durable work. A returning identity with a registry row must not derive a new alias.

### Phase 3 — new member join

Use this phase only after a current V2 repository is present and the authenticated identity has no registry row. Derive a candidate alias through the overlay, require a nonempty committed `desks/_template/`, copy the complete template tree including hidden and nested paths into `desks/<alias>/`, apply only explicit substitutions, and verify every template-relative path before registry mutation. Commit and push the new member's own-desk tree first, then add the identity-to-alias row and any authority snapshot through the conflict-safe shared-path protocol. Never add a valid-looking registry row for an incomplete desk.

## Inputs from the overlay

Before remote discovery or a new-member join, obtain a stable authenticated identity, transport, alias rule, target local path, Crew plugin locator, and overlay dependencies. If authenticated remote access cannot be proven, stop before filesystem changes; do not create an offline copy of a shared workspace.

## Step 1: resolve the crew workspace

Inspect the target local path first. If it contains a legacy Crew-v1 local workspace, route to Phase 1 repository migration and do not continue to Step 2; after migration, continue directly to Phase 2. If it is already proven to have the current V2 layout, continue to session-start sync and scan, then choose Phase 2 or Phase 3 from the committed registry. Only when no local workspace exists may an operator-supplied repository pointer or overlay discovery resolve a remote candidate.

## Step 2: offer once, then clone

For an absent local workspace only, confirm the remote contains `_meta/desks.md`, `desks/`, and `_shared/`, prove authenticated read access, and ask once whether to clone it to the target path. On yes, run the overlay-supplied transport and verify origin; on no, stop without filesystem changes.

## Step 3: choose the member phase

Read `_meta/desks.md` after local resolution. An existing identity routes to Phase 2. A new identity routes to Phase 3. The registry is authoritative; do not cache or invent a second binding.

## Completion check

Onboarding is complete only when repository identity and origin are proven, any required Crew-v1 migration is marked complete with rollback evidence, the identity maps to exactly one alias, member state and shared records are preserved, authority reports the Crew root and alias, read-across/write-own and conflict-safe shared writes are verified, declared tooling and repository context are available, and a new registry row exists only after complete desk verification.

## Cross-references

- `desk:first-run-bootstrap`: the single-operator Desk path.
- `crew:shared-desk-conventions`: layout, ownership, and shared-path serialization.
- The active overlay's identity and transport skill: authentication, transport, and alias defaults.
