# Job bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

## What happened

- Status: processing (measured, declared evidence).
- Sessions: 2 bound, 1 on the job clock (measured); by host: claude-code 1, copilot-cli 1 (measured).
- Shared work: 1 session shared with 1 other job (measured).
- Lead time: 12000 ms (partial: the job was still open when this was measured).
- Queue before start: 2000 ms (partial: the source could not be read; 1 session uncovered).
- Active time: 8000 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered) in total; inside the lead-time window: 8000 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered).
- Active before card (work before the task card existed, outside lead time): 0 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered).
- Busy time: 16000 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered); parallelism: 2 (partial: it was cut to a size limit and the source could not be read; 1 session uncovered; inferred evidence).
- Flow efficiency: 66.67% (partial: it was cut to a size limit and the job was still open when this was measured and the source could not be read; 1 session uncovered; inferred evidence).
- Concurrent sessions: maximum 1, average 1.00 (partial: it was cut to a size limit and the source could not be read; 1 session uncovered; inferred evidence).
- Concurrent agents: maximum 2, average 1.50 (partial: it was cut to a size limit and the source could not be read; 1 session uncovered; inferred evidence).
- Waits: human not recorded (the host does not record it and the source could not be read), permission 1000 ms (partial: the host does not record it and the source could not be read; 1 session uncovered), API retry 500 ms (partial: the host records only some of it, so this is a lower bound and the source could not be read; 1 session uncovered), compaction wait time 0 ms (partial: the host does not record it and the source could not be read; 1 session uncovered).
- Tool calls: agent 1, edit 3, read 1 (partial: it was cut to a size limit; 1 session uncovered).
- Public pull requests: ourostack/desk#8 (partial: the host records only some of it, so this is a lower bound; 2 sessions uncovered); public commits: 1 (partial: the host does not record it; 1 session uncovered); private pull requests counted: 0 (partial: the host records only some of it, so this is a lower bound; 2 sessions uncovered); private commits counted: 1 (partial: the host does not record it; 1 session uncovered).
- Tokens: total 600 (partial: the host's record did not include it; 1 session uncovered), input 200 (partial: the host's record did not include it; 1 session uncovered), output 400 (partial: the host's record did not include it; 1 session uncovered), cache read 600 (partial: the host's record did not include it; 1 session uncovered), cache write 80 (partial: the host's record did not include it; 1 session uncovered), reasoning 20 (partial: the host's record did not include it and the host does not record it; 1 session uncovered).
- Status transitions: processing at 2500 ms (measured).
- Sign-off: not recorded.
- Human attention: not recorded (no session of the job recorded the human's turns).

## What mattered

- Active time inside the lead-time window: 8000 ms, 66.67% of lead time (partial: it was cut to a size limit and the job was still open when this was measured and the source could not be read; 1 session uncovered; inferred evidence).
- Queue before start: 2000 ms, 16.67% of lead time (partial: the job was still open when this was measured and the source could not be read; 1 session uncovered; inferred evidence).
- Lead-time contributors are partial: it was cut to a size limit and the job was still open when this was measured and the host does not record it and the host records only some of it, so this is a lower bound and the source could not be read.
- Longest single wait: permission wait, 1000 ms (partial: the host does not record it and the host records only some of it, so this is a lower bound and the source could not be read; 2 sessions uncovered).

## What was waste

Not classified yet: no session of this job has labels from the independent evaluator.
- Candidate signals only (inferred): 1 tool failure (partial: it was cut to a size limit; 1 session uncovered), 2 tool retries (partial: it was cut to a size limit; 1 session uncovered), 1 API retry (partial: the host records only some of it, so this is a lower bound; 1 session uncovered), 1 session re-touch (measured).
- Wait signals: human not recorded (the host does not record it and the source could not be read), permission 1000 ms (partial: the host does not record it and the source could not be read; 1 session uncovered), API retry 500 ms (partial: the host records only some of it, so this is a lower bound and the source could not be read; 1 session uncovered), compaction wait time 0 ms (partial: the host does not record it and the source could not be read; 1 session uncovered).

## What we could not see

- API retries: the host records only some of it, so this is a lower bound (1 session).
- Commits: the host does not record it (1 session).
- Compaction wait time: the host does not record it (1 session).
- Session end time: the session was still open (1 session).
- Human waits: the host does not record it (1 session).
- Job clock offsets: the source could not be read (1 session).
- Models: the host's record did not include it (1 session).
- Permission waits: the host does not record it (1 session).
- Pull requests: the host records only some of it, so this is a lower bound (2 sessions).
- Reasoning tokens: the host does not record it (1 session).
- Model requests: the host's record did not include it (1 session).
- Tokens: the host's record did not include it (1 session).
- Tool durations: it was cut to a size limit (1 session).
- First-pass yield: not recorded (no outcome record is available).
- Rework: not recorded (no outcome record is available).

How to read these numbers: measured means every session that should supply a number did; partial means the number is a lower bound or covers only some sessions, and the reason follows; not recorded means there is no number, which is never zero. API retry counts are the errors the host surfaced: Claude surfaces only some of them, so its count is a lower bound, and Codex does not record them. Human wait is the gaps between prompts inside a session. Tool failure and retry definitions differ by host: Codex reads an output layout it does not recognise as ok, and Copilot adds denied. The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it. Cost in money is not measured in v0.
