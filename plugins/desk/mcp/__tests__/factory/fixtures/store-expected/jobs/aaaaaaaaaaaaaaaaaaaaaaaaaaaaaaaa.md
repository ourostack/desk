# Job aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## What happened

- Status: done (measured).
- Sessions: 2; claude-code 1, copilot-cli 1; 2 on the job clock.
- Shared work: 1 session shared with 1 other job.
- Lead time: 14000 ms (measured).
- Queue before start: 0 ms (measured).
- Active time: 14000 ms (measured) in total; inside the lead-time window: 13000 ms (measured).
- Active before card (work before the task card existed, outside lead time): 1000 ms (measured).
- Busy time: 27000 ms (measured); parallelism: 1.9285714285714286 (inferred).
- Flow efficiency: 92.86% (inferred).
- Concurrent sessions: maximum 2, average 1.07 (inferred).
- Concurrent agents: maximum 2, average 1.50 (inferred).
- Waits: human 2000 ms (measured, partial: 1 session uncovered), permission 1000 ms (measured, partial: 1 session uncovered), API retry 500 ms (measured), compaction 0 ms (measured).
- Tool calls: agent 2, edit 3, shell 2.
- Public pull requests: ourostack/desk#7, ourostack/desk#8; public commits: 2; private references counted: 1 pull request and 2 commits.
- Status transitions: processing at 0 ms, validating at 7000 ms, done at 14000 ms.

## What mattered

- Active time inside the lead-time window: 13000 ms (92.86% of lead time; inferred).
- Human wait: 2000 ms (14.29% of lead time; inferred, partial: 1 session uncovered).
- Longest single wait: human wait, 2000 ms (measured, partial: 2 sessions uncovered).

## What was waste

Not classified yet: the independent evaluator arrives in slice 2.
- Candidate signals only (inferred): 2 tool failures, 3 tool retries, 1 API retry, 1 session re-touch.
- Wait signals: human 2000 ms (measured, partial: 1 session uncovered), permission 1000 ms (measured, partial: 1 session uncovered), API retry 500 ms (measured), compaction 0 ms (measured).

## What we could not see

- human_waits: host_does_not_record (1 session).
- permission_waits: host_does_not_record (1 session).
- First-pass yield: unavailable (not_collected_in_slice_1).
