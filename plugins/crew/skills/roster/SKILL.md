---
name: roster
description: The team's roster in a Crew workspace, the one Markdown file of everyone the team works with (teammates and contacts) and what is worth knowing about them. Owns where it lives, how an entry is written, the questions a newcomer is asked and how a team changes them, when to add or update an entry, and how an edit lands. Invoke whenever a person is named in work in a Crew workspace (a teammate, partner, customer contact), when someone asks who a person is, who to ask about something, how to reach someone or what their pronouns are, during crew:join-crew's interview, and at the set-up check of a member with no roster entry. Not the desk list in _meta/desks.md, which binds accounts to desks.
---

# The team's roster

The roster is the team's people file: everyone the team works with, teammates and the people outside the team, and what is worth knowing about them (role, what they work on, who to go to them for, how to reach them, pronouns, other spellings of their name). Every teammate and every teammate's agent reads it, so a person learned about once is known to the whole team.

It is not the desk list. `_meta/desks.md` binds each member's account to their desk and is written only by Crew's script; say "desk list" for it and "roster" only for the people file.

## Where it lives

`people` in `_meta/crew.json` names the roster's path; without it, the roster is `_shared/landscape/roster.md`. `crew.js status` reports it as `people.path`, with `people.exists`, and with `--identity`, `people.listed` (whether the member's alias or identity appears in it). A team that already keeps a people file names it when the workspace starts (`crew.js start --people <file>`); the file is used as it is. A workspace with no roster file gets one from Crew's starter: `crew.js status` returns the starter as `people.starter` while the file is missing, and the next join creates it.

```bash
node <Desk plugin folder>/mcp/scripts/crew.js status --repo <clone> [--identity <login>]
```

`<Desk plugin folder>` is the folder whose `mcp/scripts/session-boot.js` your `Desk startup:` line runs.

## How to write an entry

Match the file's own format: a row in a table roster, a section in a roster of sections. Crew's starter uses one `### Name (alias)` section per person under `## Teammates` or `## Contacts`, with short labeled lines (Role, Works on, Go to them for, Pronouns, Reach them, Notes, Source), leaving out any line nothing is known about.

- Say where each fact came from and when: "told us when joining, 2026-10-27", "said in the 2026-10-20 planning meeting", "directory profile, 2026-10-26".
- A role is what we have seen someone do, not a formal charter.
- Record other spellings of a name; transcripts mangle them.
- Never guess pronouns. Write "not shared" (or what the file already uses, such as "not recorded") until the person tells us.
- Say who to go to for what.
- Attribute one person's opinion of someone to them ("Pat finds them quick on billing questions"); it is not a team fact.
- Keep anything private or sensitive out: health, family, pay, performance, anything said in confidence.
- Never invent anything. A missing fact stays missing.
- Include the member's alias or GitHub identity in their own entry, so `crew.js status` can tell that the roster lists them.

## The questions a newcomer is asked

The roster's `## What we ask new teammates` section lists them; a team changes what it asks by editing that list. `crew.js status` returns them as `people.questions` (`people.questions_from` is `roster`, or `crew` when the file has no such list and Crew's defaults apply):

1. What name do you go by (and your full name, if different)?
2. Your pronouns, if you'd like to share them.
3. Your role, and what you're working on these days.
4. What should teammates come to you for?
5. How do you like to be reached, and what's your time zone or usual hours?
6. Anything else the team should know?

One more question is always asked and its answer never goes in the roster, because it is instructions to the person's own agent: "How do you like your agent to work with you? For example, short answers or detail, check in often or just get it done." Its answer goes in their own `desks/<alias>/AGENTS.md`.

Ask all of them in one chat message, numbered, saying any can be skipped; never use a form. When the roster already has an entry for the person, show what it says and ask only for what is missing or wrong. `crew:join-crew` runs this at join.

## When to add or update an entry

- **At join**: `crew:join-crew` interviews the newcomer and lands their entry with their desk-list row.
- **At the set-up check**: a member whose `people.listed` is false is offered the same short interview once; land the entry with `crew.js roster` (below). If they decline, do not ask again.
- **When a person comes up in your work**: a teammate's new role, a partner who owns something, a customer contact, a better way to reach someone. Add or update their entry, with where you learned it and the date. Move a contact to Teammates when they join, if the file has both sections.

## Answering questions about people

For "who is Y?", "who should I ask about X?", "how do I reach Y?" or "what are Y's pronouns?", read the roster first and answer from it, saying where each fact came from and how old it is. When the roster does not say, say so, then look elsewhere (the person's own desk, team facts in `_shared/landscape/`), and offer to add what you find. Never guess a pronoun; use the person's name or "they" when none is recorded.

## How an edit lands

The roster is a shared file, so an edit lands through a pull request that Crew's script opens and merges at once; never commit it straight to the default branch, and never open the pull request by hand.

1. Edit the roster in the clone's working tree. Nothing else may be uncommitted: the script refuses any other change.
2. Run the plan, then apply:

   ```bash
   node <Desk plugin folder>/mcp/scripts/crew.js roster --repo <clone> --identity <login>
   node <Desk plugin folder>/mcp/scripts/crew.js roster --repo <clone> --identity <login> --apply
   ```

   Only a member on the desk list can run it. A newcomer's own entry lands with `crew.js join` instead.
3. Tell the person the result's `message` in plain words:
   - `updated`: merged; with `confirmed: false`, merged on GitHub but not yet downloaded here.
   - `unchanged`: there was nothing to land, or the default branch already has it.
   - `pr_open`: waiting for GitHub to merge it; the edit is back in the clone, and running the same command again reuses that pull request.
   - `failed` at stage `people`: a teammate changed the same lines first. The clone now shows the roster as it is; read it again, write the entry again, and run `roster --apply` again.
   - `refused`: nothing was written; fix what the message names.

The script merges the edit with what teammates changed meanwhile. Two entries added at the same place both land, the teammate's first; only a change to the same existing lines stops at stage `people`.

## Cross-references

- `crew:join-crew`: the interview at join.
- `crew:start-crew`: naming an existing people file with `--people`.
- `crew:shared-desk-conventions`: the layout and the shared-write protocol.
- `crew:perspective-query`: one person's views, read from their own desk.
