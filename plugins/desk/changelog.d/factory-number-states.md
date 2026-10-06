The factory report now shows, for the numbers on its job and rollup pages, whether each one was measured, partial or not recorded, and why. This covers the waste lines on job pages too. A number that was not recorded is shown as "no data" with its reason and is never shown as zero. A partial number keeps its value as a lower bound and names what is missing. Dollar cost is not measured.

The pages also say what each host never records. Claude Code does not record compaction time, reasoning tokens, commits or permission waits, and records API retries only partly. Codex does not record compaction time, commits, permission waits or API retries, and records tool outcomes, requests and tokens only partly. Copilot's default entrypoint is not a recorded fact.

Pull request counts are recorded only partly on every host, so they are shown as partial, a lower bound. Claude API retries are not renamed to hide that gap: they are shown as partial, a lower bound, because the host records them only partly.

Compactions are shown two ways, and the pages keep them apart. The compaction count is how many compactions happened, and every host records it. The compaction wait time is recorded only where the host records it, so it reads as not recorded for Claude Code and Codex.

The derivers now flag what a host does not record or left out: compaction time, commits, reasoning tokens, usage fields that are absent from a log, a damaged log, and subagents that could not be read. A usage field that is absent is recorded as not recorded instead of as 0. A bound session whose job clock was lost makes the job's clock numbers partial. Where a count inside a job's references value is not recorded, it is null, not 0. Old facts are read as not recorded where the host never recorded a field, without changing the stored file. A reason the report cannot put into plain words now stops the render instead of printing.

Published facts move to `desk.factory.published/2`, and the local facts to `desk.factory.local/2`. Readers accept `/1` and `/2` alongside each other, and the flag list is no longer trimmed. The store must accept `/2` before this ships, and a plugin release must wait for that.

Each job gains a token total, split into input, output, cache read, cache write and reasoning. It is partial when the job owns only some of a session's workers, and it is not recorded, never 0, when no session supplies a type.

Rollups now say how many jobs they counted out of how many, and medians use measured values only. The alarm and the kaizen check say when they compare lower bounds. A new `rollups/totals.json` carries fact-level totals per host and overall for the site, each with its state, how many sessions it counted of how many, and its reasons.

Nothing here changes who is credited with which time.
