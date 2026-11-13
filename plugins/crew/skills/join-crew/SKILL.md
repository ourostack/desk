---
name: join-crew
description: Migrate a legacy Crew repository in place before existing-member activation, or join a new member to a current Epoch 2 Crew workspace with the crew script, ending with a short interview that adds them to the team roster. Preserve repository identity, history, member state, shared records, authority boundaries, and conflict-safe shared writes; never create a parallel migration repository. Installs the team's plugin from the workspace's tooling repository (dual-repo) or its plugins/ folder (monorepo). A repository that is not a Crew workspace yet goes to crew:start-crew.
---

# Join a crew workspace

Bring an operator into a shared workspace without asking them to perform work the agent can do. This skill owns the vendor-neutral flow. An overlay supplies identity, authentication, transport, default alias policy, target path, and private dependency details. Read `desk:first-run-bootstrap` and `crew:shared-desk-conventions` first.

The checks and writes are one deterministic script; run it rather than doing its steps by hand:

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone> --identity <login>
node <Desk plugin folder>/mcp/scripts/crew.js join --repo <clone> --identity <login> --alias <alias> [--adopt-existing <reviewed-commit>] [--apply]
```

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs. Each command prints one JSON result; tell the person its `message`.

## Path 2 — migrate the Crew workspace, then activate members

Resolve the local workspace before choosing a member flow. An existing legacy repository must complete Phase 1 in place. A repository proven current Epoch 2 may skip migration and continue to sync. Remote discovery is only for a workspace that is not already present locally.

### Phase 1 — repository migration

Run this executable branch in the existing repository path before member activation.

1. Detect legacy layout and repository identity by proving the current path, Git worktree root, origin, branch and commit, committed registry, legacy Crew-v1 declarations or directories, and the evidence that the workspace is not yet current Epoch 2. Only a workspace proven to be current Epoch 2 may skip this migration and continue to ordinary sync.
2. Inventory repository state by recording tracked, ignored, and untracked state, member-specific subtrees, durable local state, `_meta/desks.md`, current dependency declarations, active tooling, machine-local bindings, and shared-path contents.
3. Record rollback evidence by capturing the current commit or other rollback ref, origin, branch relationship, full status and inventory, legacy declarations, and restoration instructions before mutation.
4. Reconcile the Epoch 2 layout in place by creating or reconciling every required `desks/<alias>/` subtree plus `_shared/landscape/` and `_shared/decisions/`, preserving Git history, origin, committed registry, durable state, ignored and untracked inventory, and every existing member's content.
5. Reconcile Epoch 1-only machinery by mapping it to a reviewed Epoch 2 owner, removing it when obsolete, or explicitly retaining it with a recorded reason, dependency, and authority boundary.
6. Declare the reviewed Epoch 2 dependency chain for Crew and its selected overlay without leaving a second active legacy chain.
7. Verify preservation and authority by proving repository identity, Git history, origin, tracked and local state, registry bindings, each member subtree, Crew read-across/write-own, and conflict-safe shared writes to `_shared/landscape/`, `_shared/decisions/`, and other serialized shared paths.
8. Mark repository migration complete in durable repository evidence only after every preservation, dependency, authority, and write-safety check passes.
9. Continue directly to existing-member activation against this migrated repository; do not enter remote or workspace discovery and do not create a duplicate or parallel Crew repository.

### Phase 2 — existing member activation

Read the committed `_meta/desks.md` registry (`crew.js status --identity <login>` reports the match as `member`), resolve the authenticated identity to exactly one existing alias, check with `crew.js status --identity <login>` that `session.ready` is true (a Desk session started in this clone binds it and writes to `desks/<alias>/`; Desk takes the person from the desk list itself, on every host, so there is no launch setting to change), verify repo-wide reads and writes rooted under `desks/<alias>/`, load declared tooling and repository context, and continue the existing member's durable work. A returning identity with a registry row must not derive a new alias.

### Phase 3 — new member join

Use this phase only after a current Epoch 2 repository is present and the authenticated identity has no registry row. Derive a candidate alias through the overlay, then run `crew.js join --identity <login> --alias <alias>`, read the plan, and run it again with `--apply`. The script requires a nonempty committed `desks/_template/`, copies the complete template tree including hidden and nested paths into `desks/<alias>/`, applies only the `{{alias}}` and `{{identity}}` substitutions, and verifies every template-relative path before registry mutation. It commits and pushes the new member's own-desk tree first, then adds the identity-to-alias row through the conflict-safe shared-path protocol (a pull request merged at once). It never adds a valid-looking registry row for an incomplete desk, refuses an alias that belongs to another identity or a desk pushed for someone else, checks both again when a teammate's change lands first, and on a rerun after an interrupted join adds only the missing row. The script signs in as the signed-in gh account that can push to the workspace; no account switch is needed. What each result means, and what to do next:

- `joined`: the script read the default branch back and found the row and the desk. Install the team's tooling (below), give the short interview (below), then run the completion check. With `confirmed: false`, GitHub merged the row but this clone could not fetch it afterwards (`reason` has Git's words, for you, not the person). Once the network is back, run `git pull` in the clone and `status --identity <login>` yourself, then tell the person in plain words that they joined, or what `status` shows instead.
- `member`: the identity already had a row, possibly added from another machine meanwhile; nothing more to write. Use the alias the result names, and give the short interview (below) if the team roster has no entry for them.
- `pr_open`: the desk is pushed and the row waits in an open pull request, so the member is not on the desk list (`_meta/desks.md`) yet. Tell the person the message's plain reason. Do not open another pull request or edit the desk list by hand: running the same `join --apply` again later, signed in as the same account, reuses that pull request and tries to merge it again, and someone allowed to merge into the default branch can merge it meanwhile. The script reuses only a pull request it opened itself for this exact identity and alias, changing only the roster, and rebuilds it from this run's own row before merging, so nothing pushed onto it meanwhile is merged; anyone else's pull request is left alone and never merged.
- `refused`: nothing was written. A registered alias or conflicting pending claim must be reconciled with its owner; choose another alias only when the intended alias genuinely belongs to someone else. An unregistered folder with existing work follows the adoption procedure below, keeping the intended alias.
- `failed`: it stopped at the named `stage`. An ordinary join whose desk is already pushed can run `join --apply` again to add only the row. An interrupted adoption instead requires a fresh reviewed inventory and explicit `--adopt-existing <reviewed-commit>` confirmation until registration finishes; ordinary resumption cannot drop its member-authentication or revision checks. At `push` with GitHub's `GH006` "Protected branch update failed", the default branch does not take the member's direct desk push: someone who administers the repository allows members to push to it (see `crew:start-crew`, "What the repository must allow"), then retry the appropriate flow. At `verify`, read the result: the row may be missing, still in an open PR, or merged while content or reservations changed. Run `status --identity <login>`, review the current contents and authority, and keep onboarding open until the named check passes.

#### Finish an existing unregistered folder

An existing folder can be a partially set-up desk, not a taken alias. Keep the requested desk identity. The absence of template files or `Crew-Identity` trailers, and a document's author, do not establish folder ownership.

1. Read the folder's contents, history, registry bindings and path reservations. Establish that the authenticated member has authority to adopt it and reconcile any conflicting owner or active writer. Run the ordinary join preview: its refusal can include `adoption.revision`, `preserved` and `missing`, listing what adoption will keep and add. An absent adoption offer names a collision, unsafe path or inventory problem to resolve without overwriting anything; do not work around the refusal by writing the registry yourself.
2. Show the inventory and obtain explicit confirmation to reuse this folder. Run `join --repo <clone> --identity <login> --alias <alias> --adopt-existing <adoption.revision>` to preview the adoption, then repeat with `--apply` after confirmation. The revision is the full commit from the reviewed inventory, not `HEAD`. The helper verifies the publishing account as this member, checks the reviewed desk and template again after fetching and on retries, preserves every existing file (including custom template files), adds only missing template paths and uses the existing shared-write protocol for the registry row. Before trusting the absence of an ownership claim, it verifies complete Git history; a shallow clone gets one bounded authenticated fetch of the default branch's full history, including during preview. If the fetch fails or the upstream still supplies only partial history, it stops at `history` without writing member files or a registry row and reports the precise recovery failure. It refuses changed contents, conflicting reservations or pending claims, symlinks, file/directory collisions, and untracked or ignored files outside the reviewed commit. Preserve those files and reconcile their inventory; never delete or publish private content merely to satisfy the helper.
3. Finish canonical filing as agent work after membership is confirmed. Read each loose document and the existing tracks/tasks; use `desk:directory-structure` and `desk:adopt-inflight-work` to reuse its actual work context, not a destination guessed from the filename. Move misplaced content into the matching track/task/document structure, preserving its meaning, attribution and history. Inspect destination collisions and preserve both versions rather than overwrite. Repair relative links in moved documents and incoming references; use the shared-write protocol for authorized changes outside the member's desk. If an incoming reference cannot be changed through an authorized path, retain a working compatibility pointer at the old path. Leave another member's content untouched.
4. Verify the canonical destinations, preserved content and working references, then run the completion check below. On a rerun, use the registered alias and finish only the missing filing/setup; do not create a duplicate task or move the same material again. A helper result of `joined` completes registry setup, not onboarding while misplaced content, collisions or unresolved authority remain.

## Inputs from the overlay

Before remote discovery or a new-member join, obtain a stable authenticated identity, transport, alias rule, target local path, and overlay dependencies. If authenticated remote access cannot be proven, stop before filesystem changes; do not create an offline copy of a shared workspace.

## Team tooling

A Crew workspace is one of two setups, which differ only in where the team's plugin lives; `crew.js status` reports which as `setup`:

- **dual-repo**: `_meta/crew.json` names a separate tooling repository (`tooling.repo`) that holds the team plugin;
- **monorepo**: the plugin is in the workspace's own `plugins/<name>/`, which is how every workspace made before `_meta/crew.json` existed works.

`crew.js status` and `join` report the plugin as `tooling`, with the install command for each host in `tooling.install` (`copilot` for Copilot through Agency, `claude` for Claude Code). Run the one for this host; the Copilot command always fetches the team plugin's current version. When `tooling.install` is null, `tooling.message` says why: the tooling repository holds no plugin yet (tell the person where it is and install nothing), a monorepo's origin is not on GitHub (install from the clone), or a monorepo has several plugins and none is named as the team's (ask the team which, and record it as `tooling.path` and `tooling.plugin` in `_meta/crew.json` through a pull request). A workspace with no plugin at all reports `tooling: null`.

On Claude Code, `tooling.install.claude` is null whenever there is no Claude Code marketplace for the plugin: always in a monorepo, and in a dual-repo workspace whose tooling repository has no `.claude-plugin/marketplace.json`. Tell the person the team plugin cannot be installed in Claude Code yet and where it lives; the team can add the marketplace file to the tooling repository and `tooling.marketplace` to `_meta/crew.json` through a pull request. Do not install it some other way.

## Step 1: resolve the crew workspace

Inspect the target local path first. If it contains a legacy Crew-v1 local workspace, route to Phase 1 repository migration and do not continue to Step 2; after migration, continue directly to Phase 2. If it is already proven to have the current Epoch 2 layout (`crew.js status` says `crew`), continue to session-start sync and scan, then choose Phase 2 or Phase 3 from the committed registry. If `crew.js status` says `not_crew`, the repository is not a Crew workspace yet: stop, tell the person its message ("This repository is not a Crew workspace yet..."), and route the setup to `crew:start-crew`; do not create Crew folders by hand. Only when no local workspace exists may an operator-supplied repository pointer or overlay discovery resolve a remote candidate.

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

Run `crew.js status --repo <clone> --identity <login>` after the join, canonical filing of any preexisting loose content, and the tooling install. Its `session` says what a Desk session started in the clone binds, from Desk's own resolvers: `session.ready` true means the next session there binds the workspace and writes to `desks/<alias>/` as this person, which is the activation check, done in this session. Only then is the join deliverable: move the task to `done` and give the delivery with "Accept or send back?". When `session.ready` is false, fix what `session.message` names yourself (for example, run the gh sign-in for the account that joined; only a password, MFA or new-consent screen you actually reach goes to the person, naming that screen), then run `status` again. While it stays false, tell the person in plain words what is left, keep the task open, and do not ask for acceptance. Tell the person to start their sessions anywhere inside the clone (a repository cloned inside it is its own project and does not count). In a later session, the answer to "am I set up?" is `desk_status` `write_scope`: `mode: person` with their alias and source `crew-roster` means yes; `activation.source` describes how Desk itself was started and says nothing about the member.

Before the onboarding handoff, use `crew:shared-initiative` to read the workspace's existing `_shared/tracks/` navigation and introduce relevant shared efforts alongside the member's own tasks. An absent or empty directory means none are recorded, not missing setup. Do not create initiatives or assign the newcomer work just because they joined.

Onboarding is complete only when repository identity and origin are proven, any required Crew-v1 migration is marked complete with rollback evidence, the identity maps to exactly one alias, member state and shared records are preserved, `crew.js status` reports `session.ready` (the Crew root and the alias), read-across/write-own and conflict-safe shared writes are verified, declared tooling (installed, or pointed to when its repository has no plugin yet) and repository context are available, and a new registry row exists only after complete desk verification.

## Cross-references

- `desk:first-run-bootstrap`: the single-operator Desk path.
- `crew:start-crew`: start a Crew workspace in a new or existing repository, monorepo or dual-repo.
- `crew:shared-desk-conventions`: layout, ownership, and shared-path serialization.
- `crew:roster`: where the team roster is and how to add to it.
- The active overlay's identity and transport skill: authentication, transport, and alias defaults.
