# crew

The **multi-person shared-workspace** layer on top of the `desk` substrate. Where `desk` is a single
operator's workspace, `crew` is what turns one git repo into a shared workspace for N teammates:

- **read-across / write-own** -- every teammate reads the whole repo (all `desks/<alias>/` + `_shared/`),
  but writes only their own `desks/<alias>/` subtree, so concurrent work merges cleanly.
- **the attribution taxonomy** -- facts (team-neutral, in `_shared/landscape/`) vs perspectives (one
  person's view, in their desk, attributed) vs decisions (what the team actually agreed, in
  `_shared/decisions/`). Never present one person's view as the team's.
- **the conflict-safe write protocol** -- direct push to your own desk; a shared path goes through a
  pull-latest -> branch -> PR -> merge-now serialization (no human review gate; the PR is a concurrency
  primitive).
- **team lessons** -- a correction that holds for the whole team goes, attributed and sourced, into the root `AGENTS.md` of the repository the team works in, which Desk's session start, Copilot CLI and Codex load (Claude Code through `CLAUDE.md`), so nobody teaches it twice; a personal one goes into that person's `desks/<alias>/AGENTS.md`. `lesson_add` routes each one and writes a team lesson through a pull request it merges.
- **perspective queries** -- answer "what would `<person>` think about X", "what's `<person>` working
  on", "what's actually agreed vs just a fact", read from the right home and attributed honestly.
- **crew onboarding** -- clone a shared workspace through an overlay-supplied identity, resolve the
  committed identity-to-alias mapping, seed a new member from the complete repo template, and bind writes
  to that member's desk.
- **start a crew** -- give a new or existing repository the workspace layout without deleting or moving
  anything, as a dual-repo workspace (the team's plugin in a separate tooling repository) or a monorepo
  (the plugin in its own `plugins/`). Desk's `crew.js` script does each step.

Vendor-neutral. Layers on top of `desk`. A corporate overlay supplies
the identity skin (how a teammate's writes authenticate); this plugin is the substrate-neutral core.

## Skills

- `shared-desk-conventions` -- the layout, the taxonomy, the write protocol, team lessons and preparing for a meeting together in one shared folder.
- `perspective-query` -- the read side: answer perspective- and status-shaped questions honestly.
- `join-crew` -- vendor-neutral onboarding; an overlay supplies identity, transport, and private tooling.
- `start-crew` -- start a workspace in a new or existing repository, monorepo or dual-repo.
- `roster` -- the team's people file: the team and everyone it works with; joining ends with a short interview that adds the newcomer.
