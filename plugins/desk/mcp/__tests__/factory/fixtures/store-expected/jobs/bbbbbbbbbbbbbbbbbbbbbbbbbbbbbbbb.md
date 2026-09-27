# Job bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

## What happened

- Status: processing (declared).
- Sessions: 2; claude-code 1, copilot-cli 1; 1 on the job clock.
- Shared work: 1 session shared with 1 other job.
- Lead time: 12000 ms (censored).
- Queue before start: 2000 ms.
- Active time: 8000 ms; busy time: 16000 ms; parallelism: 2.
- Concurrent sessions: maximum 1, average 1.00.
- Concurrent agents: maximum 2, average 1.50.
- Waits: human 0 ms, permission 1000 ms, API retry 500 ms, compaction 0 ms.
- Tool calls: agent 1, edit 3, read 1.
- Public references: 1 pull request and 1 commit; private references counted: 0 pull requests and 1 commit.
- Status transitions: processing at 2500 ms.

## What mattered

- Active time: 8000 ms (66.67% of lead time).
- Queue before start: 2000 ms (16.67% of lead time).
- Longest single wait: permission wait, 1000 ms.

## What was waste

Not classified yet: the independent evaluator arrives in slice 2.
- Candidate signals only: 1 tool failure, 2 tool retries, 1 API retry, 1 session re-touch.
- Wait signals: human 0 ms, permission 1000 ms, API retry 500 ms, compaction 0 ms.

## What we could not see

- ended_at: session_open (1 session).
- human_waits: host_does_not_record (1 session).
- job_offsets: source_unreadable (1 session).
- tool_durations: capped (1 session).
- First-pass yield: unavailable (not_collected_in_slice_1).
