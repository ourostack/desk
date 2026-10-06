# Factory report index

## Jobs

| Job | Lead time | Active time | Active before card | Flow efficiency |
| --- | ---: | ---: | ---: | ---: |
| 11111111111111111111111111111111 | 10000 ms (measured) | 8000 ms (measured) | 0 ms (measured) | 80.00% (measured, inferred evidence) |
| 22222222222222222222222222222222 | 25000 ms (measured) | 17000 ms (measured) | 0 ms (measured) | 68.00% (measured, inferred evidence) |
| 33333333333333333333333333333333 | 18000 ms (measured) | 12000 ms (measured) | 0 ms (measured) | 66.67% (measured, inferred evidence) |
| 44444444444444444444444444444444 | 8000 ms (partial: the job was still open when this was measured) | 7000 ms (measured) | 0 ms (measured) | 87.50% (partial: the job was still open when this was measured; inferred evidence) |
| 55555555555555555555555555555555 | not recorded (the job was cancelled) | 8000 ms (measured) | 0 ms (measured) | not recorded (the job was cancelled) |
| 66666666666666666666666666666666 | 10000 ms (measured) | 7000 ms (measured) | 0 ms (measured) | 70.00% (measured, inferred evidence) |

Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time. Each number carries its state: measured, partial with its reason, or not recorded.

Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.

## Coverage

- Sessions seen: not recorded (the store only receives published facts, so it cannot count sessions that never published any).
- Sessions with facts: 10 (measured).
- Bound sessions: 9 (measured).
- Unattributed sessions: 1 (measured).
- Host claude-code: 5 sessions (measured).
- Host copilot-cli: 5 sessions (measured).

### Unavailable evidence

- API retries: the host records only some of it, so this is a lower bound (5 of 10 sessions, 50.00%).
- Commits: the host does not record it (5 of 10 sessions, 50.00%).
- Compaction wait time: the host does not record it (5 of 10 sessions, 50.00%).
- Entrypoint: the host does not record it (5 of 10 sessions, 50.00%).
- Human waits: the host does not record it (5 of 10 sessions, 50.00%).
- Models: the host's record did not include it (10 of 10 sessions, 100.00%).
- Permission waits: the host does not record it (5 of 10 sessions, 50.00%).
- Pull requests: the host records only some of it, so this is a lower bound (10 of 10 sessions, 100.00%).
- Reasoning tokens: the host does not record it (5 of 10 sessions, 50.00%).
- Model requests: the host's record did not include it (10 of 10 sessions, 100.00%).
- Tokens: the host's record did not include it (10 of 10 sessions, 100.00%).

### Plugin versions

- desk 3.1.0: 3 sessions (measured).
- desk 3.1.1: 7 sessions (measured).
