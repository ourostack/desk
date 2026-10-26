`lesson_add` now puts a correction where something loads it, and its reply says whether the lesson is in effect. Before, it wrote `_meta/tips/<topic>.md`, which nothing read, so agents told people a lesson was kept when no session would ever see it. The call now needs a `scope`:

- `personal` adds a one-line rule to the `## Lessons` section of the person's AGENTS.md, which every session start prints. In a shared workspace that is `desks/<alias>/AGENTS.md`, and session start now prints it after the workspace's own AGENTS.md.
- `desk` needs an `owner` (a skill, a Desk tool, the child brief or the always-on foundation). It records system friction against that owner, which opens an improvement card; the reply says the lesson is not in effect until that card's change ships, or that no card opened and why.
- `team` returns the attributed line for a shared workspace's AGENTS.md, to write through Crew's shared-path protocol.

A lesson that would push an AGENTS.md past what session start prints is refused. Existing tips files stay searchable; [lesson-capture](skills/lesson-capture/SKILL.md) now records each lesson this way.
