# Job bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

## What happened

- Status: processing (declared).
- Sessions: 2; claude-code 1, copilot-cli 1; 1 on the job clock.
- Shared work: 1 session shared with 1 other job.
- Lead time: 12000 ms (measured, censored).
- Queue before start: 2000 ms (measured).
- Active time: 8000 ms (measured) in total; inside the lead-time window: 8000 ms (measured).
- Active before card (work before the task card existed, outside lead time): 0 ms (measured).
- Busy time: 16000 ms (measured); parallelism: 2 (inferred).
- Flow efficiency: 66.67% (inferred, censored).
- Concurrent sessions: maximum 1, average 1.00 (inferred).
- Concurrent agents: maximum 2, average 1.50 (inferred).
- Waits: human unavailable (host_does_not_record), permission 1000 ms (measured), API retry 500 ms (measured), compaction 0 ms (measured).
- Tool calls: agent 1, edit 3, read 1.
- Public pull requests: ourostack/desk#8; public commits: 1; private references counted: 0 pull requests and 1 commit.
- Status transitions: processing at 2500 ms.

## What mattered

- Active time inside the lead-time window: 8000 ms (66.67% of lead time; inferred, censored).
- Queue before start: 2000 ms (16.67% of lead time; inferred, censored).
- Longest single wait: permission wait, 1000 ms (measured, partial: 1 session uncovered).

## What was waste

Not classified yet: the independent evaluator arrives in slice 2.
- Candidate signals only (inferred): 1 tool failure, 2 tool retries, 1 API retry, 1 session re-touch.
- Wait signals: human unavailable (host_does_not_record), permission 1000 ms (measured), API retry 500 ms (measured), compaction 0 ms (measured).

## What we could not see

- ended_at: session_open (1 session).
- human_waits: host_does_not_record (1 session).
- job_offsets: source_unreadable (1 session).
- tool_durations: capped (1 session).
- First-pass yield: unavailable (not_collected_in_slice_1).
