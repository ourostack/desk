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

## Human attention

Human attention per accepted outcome is an estimate, not a measurement. It is made with method version 1, and the method version is printed beside the attention figures. Desk changes the method version whenever it changes a constant, and the reports are rebuilt from the same facts, so a figure is only compared with figures of its own method version.

No host records how long a person spent reading a reply or writing a prompt. The estimate adds two parts for each human turn, reading the reply and writing the prompt, each taken from the size class of its character count. It is never more than the gap the host shows, when there is one, and never less than one second. The person may have read while the agent was still writing, and no host records that, so a figure is closer to a floor than to a ceiling.

The headline counts every human turn of every session in the period, including turns on jobs that were refused, are unsigned or were never delivered, and the total is divided by the jobs accepted and verified. A turn that falls in no job's time is shown apart as unattributed, and a turn in a session whose jobs publish no time is shown as unplaced; both stay in the headline. The same page also gives human turns per accepted outcome, a plain count over the same jobs.

The headline has three states. It is measured when every session in the period has a complete list of human turns. It is partial, a lower bound, when some session in the period flags the field: Codex records no human turns, Copilot records them only in part because a prompt there cannot be told from a hook's follow-up with certainty, and a Claude Code session whose host wrote no origin on its prompts, a session cut at 1,000 turns and a log cut short flag it too. The reasons are printed. It is unavailable, with no value and no total, when no session in the period kept a list (the reason reads no human-turn records when no session is in the period, and turns not recorded, with the host's own reason, when sessions are, for example when all are Codex). It is also unavailable, with no total, when every turn is unreadable. A turn the estimator cannot read is counted, adds no time and gives the reason that a turn could not be estimated. With no verified accepted outcome the headline is unavailable and reads no accepted outcomes yet; the total so far is still shown, as "at least" when it is partial, only when a list exists and a turn could be estimated, and the headline is never zero. Sessions in the old format (`/1`) are outside the period.

Permission decisions are shown beside the headline, not in it. Only Copilot records them, and each is taken as at most five seconds.
