---
name: join-crew
description: Migrate a legacy Crew repository in place before existing-member activation, or join a new member to a current V2 Crew workspace with the crew script, ending with a short interview that adds them to the team roster. Preserve repository identity, history, member state, shared records, authority boundaries, and conflict-safe shared writes; never create a parallel migration repository. Installs the team's plugin from the workspace's tooling repository (dual-repo) or its plugins/ folder (monorepo). A repository that is not a Crew workspace yet goes to crew:start-crew.
---

# Join a crew workspace

Bring an operator into a shared workspace without asking them to perform work the agent can do. This skill owns the vendor-neutral flow. An overlay supplies identity, authentication, transport, default alias policy, target path, and private dependency details. Read `desk:first-run-bootstrap` and `crew:shared-desk-conventions` first.

The checks and writes are one deterministic script; run it rather than doing its steps by hand:

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone> --identity <login>
node <Desk plugin folder>/mcp/scripts/crew.js join --repo <clone> --identity <login> --alias <alias> [--apply]
```

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs. Each command prints one JSON result; tell the person its `message`.

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

Read the committed `_meta/desks.md` registry (`crew.js status --identity <login>` reports the match as `member`), resolve the authenticated identity to exactly one existing alias, check with `crew.js status --identity <login>` that `session.ready` is true (a Desk session started in this clone binds it and writes to `desks/<alias>/`; Desk takes the person from the desk list itself, on every host, so there is no launch setting to change), verify repo-wide reads and writes rooted under `desks/<alias>/`, load declared tooling and repository context, and continue the existing member's durable work. A returning identity with a registry row must not derive a new alias.

### Phase 3 — new member join

Use this phase only after a current V2 repository is present and the authenticated identity has no registry row. Derive a candidate alias through the overlay, then run `crew.js join --identity <login> --alias <alias>`, read the plan, and run it again with `--apply`. The script requires a nonempty committed `desks/_template/`, copies the complete template tree including hidden and nested paths into `desks/<alias>/`, applies only the `{{alias}}` and `{{identity}}` substitutions, and verifies every template-relative path before registry mutation. It commits and pushes the new member's own-desk tree first, then adds the identity-to-alias row through the conflict-safe shared-path protocol (a pull request merged at once). It never adds a valid-looking registry row for an incomplete desk, refuses an alias that belongs to another identity or a desk pushed for someone else, checks both again when a teammate's change lands first, and on a rerun after an interrupted join adds only the missing row. The script signs in as the signed-in gh account that can push to the workspace; no account switch is needed. What each result means, and what to do next:

- `joined`: the script read the default branch back and found the row and the desk. Install the team's tooling (below), give the short interview (below), then run the completion check. With `confirmed: false`, GitHub merged the row but this clone could not fetch it afterwards (`reason` has Git's words, for you, not the person). Once the network is back, run `git pull` in the clone and `status --identity <login>` yourself, then tell the person in plain words that they joined, or what `status` shows instead.
- `member`: the identity already had a row, possibly added from another machine meanwhile; nothing more to write. Use the alias the result names, and give the short interview (below) if the team roster has no entry for them.
- `pr_open`: the desk is pushed and the row waits in an open pull request, so the member is not on the desk list (`_meta/desks.md`) yet. Tell the person the message's plain reason. Do not open another pull request or edit the desk list by hand: running the same `join --apply` again later, signed in as the same account, reuses that pull request and tries to merge it again, and someone allowed to merge into the default branch can merge it meanwhile. The script reuses only a pull request it opened itself for this exact identity and alias, changing only the roster, and rebuilds it from this run's own row before merging, so nothing pushed onto it meanwhile is merged; anyone else's pull request is left alone and never merged.
- `refused`: nothing was written; for a taken alias or desk, choose another alias.
- `failed`: it stopped at the named `stage`; when the desk is already pushed the message says so, and running `join --apply` again adds only the row. At `push` with GitHub's `GH006` "Protected branch update failed", the default branch does not take the member's direct desk push: someone who administers the repository allows members to push to it (see `crew:start-crew`, "What the repository must allow"), then run `join --apply` again. At `verify`, GitHub reported the row merged but the default branch does not hold it: run `status --identity <login>` yourself; if `member` is null, run the same `join --apply` again, which adds only what is missing, and tell the person the outcome in plain words.

## Inputs from the overlay

Before remote discovery or a new-member join, obtain a stable authenticated identity, transport, alias rule, target local path, and overlay dependencies. If authenticated remote access cannot be proven, stop before filesystem changes; do not create an offline copy of a shared workspace.

## Team tooling

A Crew workspace is one of two setups, which differ only in where the team's plugin lives; `crew.js status` reports which as `setup`:

- **dual-repo**: `_meta/crew.json` names a separate tooling repository (`tooling.repo`) that holds the team plugin;
- **monorepo**: the plugin is in the workspace's own `plugins/<name>/`, which is how every workspace made before `_meta/crew.json` existed works.

`crew.js status` and `join` report the plugin as `tooling`, with the install command for each host in `tooling.install` (`copilot` for Copilot through Agency, `claude` for Claude Code). Run the one for this host; the Copilot command always fetches the team plugin's current version. When `tooling.install` is null, `tooling.message` says why: the tooling repository holds no plugin yet (tell the person where it is and install nothing), a monorepo's origin is not on GitHub (install from the clone), or a monorepo has several plugins and none is named as the team's (ask the team which, and record it as `tooling.path` and `tooling.plugin` in `_meta/crew.json` through a pull request). A workspace with no plugin at all reports `tooling: null`.

On Claude Code, `tooling.install.claude` is null whenever there is no Claude Code marketplace for the plugin: always in a monorepo, and in a dual-repo workspace whose tooling repository has no `.claude-plugin/marketplace.json`. Tell the person the team plugin cannot be installed in Claude Code yet and where it lives; the team can add the marketplace file to the tooling repository and `tooling.marketplace` to `_meta/crew.json` through a pull request. Do not install it some other way.

## Step 1: resolve the crew workspace

Inspect the target local path first. If it contains a legacy Crew-v1 local workspace, route to Phase 1 repository migration and do not continue to Step 2; after migration, continue directly to Phase 2. If it is already proven to have the current V2 layout (`crew.js status` says `crew`), continue to session-start sync and scan, then choose Phase 2 or Phase 3 from the committed registry. If `crew.js status` says `not_crew`, the repository is not a Crew workspace yet: stop, tell the person its message ("This repository is not a Crew workspace yet..."), and route the setup to `crew:start-crew`; do not create Crew folders by hand. Only when no local workspace exists may an operator-supplied repository pointer or overlay discovery resolve a remote candidate.

## Step 2: offer once, then clone

For an absent local workspace only, confirm the remote contains `_meta/desks.md` or `desks/` (what makes a repository a Crew workspace), prove authenticated read access, and ask once whether to clone it to the target path. A remote with neither of those is not a Crew workspace yet: say so and point to `crew:start-crew` instead of cloning it as one. On yes, run the overlay-supplied transport and verify origin; on no, stop without filesystem changes. This ask carries the same risk a noninteractive session poses to `desk:first-run-bootstrap`'s A3: with no human able to answer, stop and report what was found instead of choosing yes or no on the operator's behalf.

## Step 3: choose the member phase

Read `_meta/desks.md` after local resolution. An existing identity routes to Phase 2. A new identity routes to Phase 3. The registry is authoritative; do not cache or invent a second binding.

## Short interview

A new member is interviewed briefly, once, right after they join; nobody fills in a roster entry about them beforehand. A returning member with no entry in the team roster gets the same offer, once per session. If `joined` came back with `confirmed: false`, wait until the clone is current first.

1. Find the team roster with `crew:roster`.
2. Ask in **one** plain chat message, never a form, and say any question can be skipped. Use the questions the roster lists for new teammates, if it lists any; otherwise ask what name they go by, their role, their pronouns, what they work on or know well, how and when teammates should reach them, and anything else the team should know. Add, as its own item in the same message, how they like their agent to work with them. Wait for their reply before the completion check.
3. Write their answers to the roster as one entry in the roster's own format, with their alias and GitHub login, nothing they skipped and nothing made up; note the person as the source, with the date. If they already have a row, fill in only its empty cells. Use `crew:roster` to land it.
4. Add how they like their agent to work with them to the end of their own `desks/<alias>/AGENTS.md`, never to the roster, and push it directly.
5. If they skip everything, write nothing, and say they can ask "add me to the team roster" later.

## Completion check

Run `crew.js status --repo <clone> --identity <login>` after the join and the tooling install. Its `session` says what a Desk session started in the clone binds, from Desk's own resolvers: `session.ready` true means the next session there binds the workspace and writes to `desks/<alias>/` as this person, which is the activation check, done in this session. Only then is the join deliverable: move the task to `done` and give the delivery with "Accept or send back?". When `session.ready` is false, tell the person `session.message` in plain words (for example, sign in to gh as the account that joined) and what is left, keep the task open, and do not ask for acceptance. Tell the person to start their sessions anywhere inside the clone (a repository cloned inside it is its own project and does not count). In a later session, the answer to "am I set up?" is `desk_status` `write_scope`: `mode: person` with their alias and source `crew-roster` means yes; `activation.source` describes how Desk itself was started and says nothing about the member.

Onboarding is complete only when repository identity and origin are proven, any required Crew-v1 migration is marked complete with rollback evidence, the identity maps to exactly one alias, member state and shared records are preserved, `crew.js status` reports `session.ready` (the Crew root and the alias), read-across/write-own and conflict-safe shared writes are verified, declared tooling (installed, or pointed to when its repository has no plugin yet) and repository context are available, and a new registry row exists only after complete desk verification.

## Cross-references

- `desk:first-run-bootstrap`: the single-operator Desk path.
- `crew:start-crew`: start a Crew workspace in a new or existing repository, monorepo or dual-repo.
- `crew:shared-desk-conventions`: layout, ownership, and shared-path serialization.
- `crew:roster`: where the team roster is and how to add to it.
- The active overlay's identity and transport skill: authentication, transport, and alias defaults.
