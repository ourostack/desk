---
name: leave-note
description: Use when one member's agent in a Crew workspace needs to tell another member something they should see at their next session start (a handoff, a heads-up that their work is affected, a relayed request), when session start lists notes from teammates, or when the operator has seen a note and it should be acknowledged. Covers note_leave and note_ack, when a note is the right path, relaying someone's thinking without writing in their voice, and that the whole workspace can read every note.
---

# Leave a teammate a note

A note is a dated, attributed message one member's agent leaves in another member's `desks/<alias>/_inbox/`. Their session start lists it, oldest first, until they acknowledge it. Read `crew:shared-desk-conventions` first for attribution and the shared-path write protocol; `note_leave` runs that protocol itself.

## When a note is the right path

| You want to | Use |
|---|---|
| Tell one teammate something they should see at their next session: a handoff, a change that affects their work, a question for them, a request relayed from someone else | `note_leave` |
| Record a fact, a person's perspective or an agreed decision | the taxonomy in `crew:shared-desk-conventions` |
| Coordinate an effort several people work on | the initiative card (`crew:shared-initiative`) |
| Change how every teammate's agents work | `lesson_add` with `scope: "team"` |
| Raise something that must come back every session until it is done | the workspace's own standing-ask mechanism, if it has one; a note stops showing once it is acknowledged |
| Reach someone now | the operator contacts them directly; a note waits for their next session |

Leave a note only when the operator asked for it or it is plainly part of the work they authorized. Never use notes for routine progress updates.

## Write the note

1. **`to`:** the member's alias from `_meta/desks.md`. `note_leave` refuses anyone who has not joined; tell the operator and suggest another way to reach them.
2. **`subject`:** one line that says what the note is about.
3. **`body`:** your own explanation, in your own voice, with the point first and what you are asking the reader to do, if anything. When you pass on someone's views, feedback or decisions, present them as your understanding and attribute them: "Here's my understanding of what Ari was thinking...". Never write in that person's words or voice, never present your reading as their statement, and point the reader to them for anything unclear.
4. **`related`:** links to the sources the note rests on, so the reader can check them: https URLs or paths in the workspace. Paths must exist on the default branch.

Desk adds the date, the sender (the session's person, never a value you pass) and a closing line telling the reader to ask the sender about anything unclear. Don't add your own signature.

**Everyone who can read the workspace can read the note, and Git keeps it after it is acknowledged.** Put nothing in it that the operator wouldn't post in the team's shared channel: no credentials, no private matters, no customer content the workspace's own rules keep out.

## Report what happened

`note_leave` writes one new file through a pull request it merges at once. Tell the operator what its reply says:

- `merged`: the note is left. Give its path.
- `pr_open`: not delivered yet. The pull request is open, and the reply says why it could not merge.
- `duplicate`: an identical note from you is already in their inbox (`note` names it, open or acknowledged). Nothing new was written.
- `failed`: nothing was left. Say the stage it stopped at and the reason.

## Notes left for you

Session start lists open notes under "Notes from teammates", with one instruction.

- Tell the operator about them early in your reply, in a line or two, and keep doing the work they asked for.
- Read a note in full, and its links, before you act on work it relates to.
- Questions about a note go to its sender, through the operator.
- Call `note_ack` with the note's path once the operator has seen it, not merely because you read it. The file stays in place with `status: acknowledged`, and session start stops listing it.
- Never edit, move or delete a note; `note_ack` is the only change it gets.
