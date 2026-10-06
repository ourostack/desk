# Job aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## What happened

- Status: done (measured).
- Sessions: 2 bound, 2 on the job clock (measured); by host: claude-code 1, copilot-cli 1 (measured).
- Shared work: 1 session shared with 1 other job (measured).
- Lead time: 14000 ms (measured).
- Queue before start: 0 ms (measured).
- Active time: 14000 ms (measured) in total; inside the lead-time window: 13000 ms (measured).
- Active before card (work before the task card existed, outside lead time): 1000 ms (measured).
- Busy time: 27000 ms (measured); parallelism: 1.93 (measured, inferred evidence).
- Flow efficiency: 92.86% (measured, inferred evidence).
- Concurrent sessions: maximum 2, average 1.07 (measured, inferred evidence).
- Concurrent agents: maximum 2, average 1.50 (measured, inferred evidence).
- Waits: human 2000 ms (partial: the host does not record it; 1 session uncovered), permission 1000 ms (partial: the host does not record it; 1 session uncovered), API retry 500 ms (partial: the host records only some of it, so this is a lower bound; 1 session uncovered), compaction wait time 0 ms (partial: the host does not record it; 1 session uncovered).
- Tool calls: agent 2, edit 3, shell 2 (measured).
- Public pull requests: ourostack/desk#7, ourostack/desk#8 (partial: the host records only some of it, so this is a lower bound; 2 sessions uncovered); public commits: 2 (partial: the host does not record it; 1 session uncovered); private pull requests counted: 1 (partial: the host records only some of it, so this is a lower bound; 2 sessions uncovered); private commits counted: 2 (partial: the host does not record it; 1 session uncovered).
- Tokens: total 1030 (measured), input 350 (measured), output 680 (measured), cache read 1020 (measured), cache write 140 (measured), reasoning 20 (partial: the host does not record it; 1 session uncovered).
- Status transitions: processing at 0 ms, validating at 7000 ms, done at 14000 ms (measured).
- Sign-off: not recorded.
- Human attention: not recorded (no session of the job recorded the human's turns).

## What mattered

- Active time inside the lead-time window: 13000 ms, 92.86% of lead time (measured, inferred evidence).
- Human wait: 2000 ms, 14.29% of lead time (partial: the host does not record it; 1 session uncovered; inferred evidence).
- Lead-time contributors are partial: the host does not record it and the host records only some of it, so this is a lower bound.
- Longest single wait: human wait, 2000 ms (partial: the host does not record it and the host records only some of it, so this is a lower bound; 2 sessions uncovered).

## What was waste

- Classified by the independent evaluator: 1 of 2 sessions labeled (partial: the independent evaluator has not labeled it; 1 session uncovered).
- Muda: 5000 ms, 55.56% of labeled time, by type: defects 3000 ms in 1 stretch, waiting 2000 ms in 1 stretch (partial: the independent evaluator has not labeled it; 1 session uncovered).
- Value 4000 ms; support 0 ms (partial: the independent evaluator has not labeled it; 1 session uncovered).
- Mura (unevenness) flagged on 0 stretches; muri (overburden) on 0 stretches (partial: the independent evaluator has not labeled it; 1 session uncovered).
- Candidate signals only (inferred): 2 tool failures (measured), 3 tool retries (measured), 1 API retry (partial: the host records only some of it, so this is a lower bound; 1 session uncovered), 1 session re-touch (measured).
- Wait signals: human 2000 ms (partial: the host does not record it; 1 session uncovered), permission 1000 ms (partial: the host does not record it; 1 session uncovered), API retry 500 ms (partial: the host records only some of it, so this is a lower bound; 1 session uncovered), compaction wait time 0 ms (partial: the host does not record it; 1 session uncovered).

## What we could not see

- API retries: the host records only some of it, so this is a lower bound (1 session).
- Commits: the host does not record it (1 session).
- Compaction wait time: the host does not record it (1 session).
- Human waits: the host does not record it (1 session).
- Permission waits: the host does not record it (1 session).
- Pull requests: the host records only some of it, so this is a lower bound (2 sessions).
- Reasoning tokens: the host does not record it (1 session).
- First-pass yield: not recorded (no outcome record is available).
- Rework: not recorded (no outcome record is available).

How to read these numbers: measured means every session that should supply a number did; partial means the number is a lower bound or covers only some sessions, and the reason follows; not recorded means there is no number, which is never zero. API retry counts are the errors the host surfaced: Claude surfaces only some of them, so its count is a lower bound, and Codex does not record them. Human wait is the gaps between prompts inside a session. Tool failure and retry definitions differ by host: Codex reads an output layout it does not recognise as ok, and Copilot adds denied. The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it. Cost in money is not measured in v0.
