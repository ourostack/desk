# Job aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa

## What happened

- Status: done (measured).
- Sessions: 2; claude-code 1, copilot-cli 1; 2 on the job clock.
- Shared work: 1 session shared with 1 other job.
- Lead time: 14000 ms.
- Queue before start: 0 ms.
- Active time: 14000 ms; busy time: 27000 ms; parallelism: 1.9285714285714286.
- Concurrent sessions: maximum 2, average 1.07.
- Concurrent agents: maximum 2, average 1.50.
- Waits: human 2000 ms, permission 1000 ms, API retry 500 ms, compaction 0 ms.
- Tool calls: agent 2, edit 3, shell 2.
- Public references: 2 pull requests and 2 commits; private references counted: 1 pull request and 2 commits.
- Status transitions: processing at 0 ms, validating at 7000 ms, done at 14000 ms.

## What mattered

- Active time: 14000 ms (100.00% of lead time).
- Human wait: 2000 ms (14.29% of lead time).
- Longest single wait: human wait, 2000 ms.

## What was waste

Not classified yet: the independent evaluator arrives in slice 2.
- Candidate signals only: 2 tool failures, 3 tool retries, 1 API retry, 1 session re-touch.
- Wait signals: human 2000 ms, permission 1000 ms, API retry 500 ms, compaction 0 ms.

## What we could not see

- human_waits: host_does_not_record (1 session).
- permission_waits: host_does_not_record (1 session).
- First-pass yield: unavailable (not_collected_in_slice_1).
