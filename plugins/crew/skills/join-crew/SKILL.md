---
name: join-crew
description: Use to join a new member to a Crew workspace, or to check that a returning member is set up. A repository that is not a Crew workspace yet goes to `crew:start-crew`.
---

# Join a crew workspace

Bring a person into a shared workspace without asking them to do work the agent can do. An overlay supplies identity, authentication, transport, the alias rule, the target path and private dependencies. Layout and write rules are in `crew:shared-desk-conventions`.

The checks and writes are one script; run it rather than doing its steps by hand. Each command prints one JSON result, and you tell the person its `message`.

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone> --identity <login>
node <Desk plugin folder>/mcp/scripts/crew.js join --repo <clone> --identity <login> --alias <alias> [--adopt-existing <reviewed-commit>] [--apply]
```

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs.

## Resolve the workspace

Look at the target path first. `status` says `crew` (continue), or `not_crew`: the repository is not a Crew workspace yet, so say so and use `crew:start-crew`; never create Crew folders by hand. When there is no local clone, confirm the remote has `_meta/desks.md` or `desks/`, prove you can read it, and ask once whether to clone it to the target path using the overlay's transport. With no human to answer, stop and report what you found. Without authenticated access, change nothing on disk.

## A returning member

`_meta/desks.md` maps identities to aliases. If the identity has a row, use that alias and never derive a new one. Check `status --identity <login>`: `session.ready` true means a Desk session started anywhere in the clone binds the workspace and writes to `desks/<alias>/` as this person (Desk takes the person from the desk list on every host, so there is no launch setting).

## A new member

With no row, derive a candidate alias through the overlay, run `join` and read the plan, then run it again with `--apply`. The script copies the committed `desks/_template/` into `desks/<alias>/`, substitutes `{{alias}}` and `{{identity}}`, pushes that desk, and then adds the identity-to-alias row through a pull request it merges at once. It refuses an alias that belongs to someone else and never adds a row for an incomplete desk, and a rerun after an interruption adds only what is missing. What to do with each result:

- `joined`: install the team's tooling (below), give the short interview (below), then the completion check. With `confirmed: false` this clone could not fetch the result: run `git pull` and `status` yourself once the network is back.
- `member`: the row already exists (perhaps from another machine); use the alias it names, and give the interview if the roster has no entry for them.
- `pr_open`: the desk is pushed and the row waits in an open pull request. Tell the person the reason; never write `_meta/desks.md` by hand instead. Running `join --apply` again later, as the same account, reuses that pull request and tries to merge it.
- `refused`: nothing was written, and `_meta/desks.md` stays unwritten by hand. Reconcile a conflicting alias with its owner; choose another alias only when the intended one really belongs to someone else. An unregistered folder with existing work is adopted (below).
- `failed`: it stopped at the named `stage`. A failed adoption or join is never worked around by writing `_meta/desks.md`. A rerun adds the missing row; an adoption needs a fresh reviewed inventory first. At `push` with `GH006` ("Protected branch update failed") the default branch does not take members' direct desk pushes: someone who administers the repository allows them (see `crew:start-crew`, "What the repository must allow"). At `verify`, read the result and `status`, and keep onboarding open until the named check passes.

### Adopt an existing unregistered folder

An existing folder can be a partly set-up desk, not a taken alias; keep the requested alias. The preview's refusal lists `adoption.revision`, `preserved` and `missing`. Show that inventory, get the person's confirmation to reuse the folder, preview with `--adopt-existing <adoption.revision>` (the full reviewed commit, not `HEAD`), then add `--apply`. The script keeps every existing file, adds only the missing template paths and adds the row; it stops on a shallow history it cannot deepen, a symlink, a collision or untracked files outside the commit, and says what. Preserve those files rather than delete or publish private content to satisfy it. Afterwards file the loose documents as agent work: read each, reuse its real task context with `desk:directory-structure` and `desk:adopt-inflight-work`, move it with its history, keep both versions on a collision, and repair links. Leave other members' content alone. On a rerun, finish only what is missing.

## Team tooling

First run `platform.install.copilot` from `status` or `join` (once per machine; it keeps Desk and Crew on their channels, so every later session starts on the newest release). An existing crew member runs the same line to bring an older install up to date.

`status` and `join` report the team's plugin as `tooling`, with the install command per host in `tooling.install` (`copilot`, `claude`); run the one for this host. When `tooling.install` is null, `tooling.message` says why: the tooling repository holds no plugin yet (say where it is and install nothing), a monorepo's origin is not on GitHub (install from the clone), or a monorepo has several plugins and none is named (ask the team which, and record it in `_meta/crew.json` through a pull request). On Claude Code a null install means the plugin has no marketplace; say where it lives and install nothing some other way. `tooling: null` means the workspace has no plugin.

## Short interview

Once, right after joining (and once per session for a returning member the roster lacks), in one plain chat message that says any question can be skipped: the name they go by, role, pronouns, what they work on or know well, how and when teammates should reach them, anything else the team should know, and how they like their agent to work with them. Use the roster's own questions for new teammates if it lists any. Write their answers to the roster as one entry in its format, with alias, login and the person as the source with the date; fill only the empty cells of an existing row; write nothing they skipped and make up nothing. Add the agent preference to the end of their own `desks/<alias>/AGENTS.md`, not the roster. If they skip everything, write nothing and say they can ask later. How the roster is found and edited is in `crew:shared-desk-conventions`.

## Completion check

After the join, any filing and the tooling install, run `status --identity <login>` and read `session`. `session.ready` true is the activation check: only then is the join deliverable. When it is false, fix what `session.message` names yourself (for example, the gh sign-in for the account that joined; only a password, MFA or consent screen you reach goes to the person), run `status` again, and until it is true keep the task open and say what is left. Tell the person to start sessions anywhere inside the clone (a repository cloned inside it is its own project). Later, `desk_status` `write_scope` with `mode: person` and their alias answers "am I set up?".

Before the handoff, read `_shared/tracks/` with `crew:shared-initiative` and introduce the efforts relevant to them beside their own tasks. An absent directory means none are recorded. Don't create initiatives or assign the newcomer work.
