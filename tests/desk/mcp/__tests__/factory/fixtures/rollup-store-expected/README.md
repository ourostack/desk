# Factory reports

These files are generated deterministically from validated published session facts.

- `index.md` lists job reports and coverage.
- `jobs/<job>.md` answers the four factory questions.
- `jobs/<job>.json` carries the normalized timeline and classed formulas.
- `rollups/index.md` shows which waste costs the most across jobs and the measure catalog per plugin version, host and job class; `rollups/measures.json`, `rollups/muda.json`, `rollups/tool-kinds.json`, `rollups/coverage.json` and `rollups/totals.json` carry the same numbers.
- `rollups/totals.json` holds fact-level totals per host and overall (sessions, tool calls, tool failures, model requests, tokens by type and subagent dispatches), each with its state, its value, n and N.

Published facts contain durations and offsets only. Every number carries one of three states: measured, partial or not recorded. Not recorded means there is no number, with the reason; it is never printed as zero, and a zero is printed only when a zero was measured. Partial means the number covers only part of what it should, and its reason and the count of uncovered sessions follow it. A total or a median over several sessions or jobs reads n of N: n counted a measured value, of N in all.

The reason `the host records only some of it` marks a lower bound: the host surfaced some of the records, so the real number is at least what is printed. Claude API retry counts are such a lower bound.

API retry counts are the errors the host surfaced: Claude surfaces only some of them, so its count is a lower bound, and Codex does not record them. Human wait is the gaps between prompts inside a session. Tool failure and retry definitions differ by host: Codex reads an output layout it does not recognise as ok, and Copilot adds denied. The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it. Cost in money is not measured in v0.
