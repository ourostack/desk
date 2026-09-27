# Factory report index

## Jobs

| Job | Lead time | Active time | Active before card | Flow efficiency |
| --- | ---: | ---: | ---: | ---: |
| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | 14000 ms (measured) | 14000 ms (measured) | 1000 ms (measured) | 92.86% (inferred) |
| bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | 12000 ms (measured, censored) | 8000 ms (measured) | 0 ms (measured) | 66.67% (inferred, censored) |

Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time.

Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.

## Coverage

- Sessions seen: unavailable (not_reported_to_store).
- Sessions with facts: 4.
- Bound sessions: 3.
- Unattributed sessions: 1.
- Host claude-code: 2 sessions.
- Host copilot-cli: 2 sessions.

### Unavailable evidence

- ended_at / session_open: 1 of 4 sessions (25.00%).
- human_waits / host_does_not_record: 1 of 4 sessions (25.00%).
- job_offsets / source_unreadable: 1 of 4 sessions (25.00%).
- models / host_does_not_record: 1 of 4 sessions (25.00%).
- permission_waits / host_does_not_record: 1 of 4 sessions (25.00%).
- tokens / host_does_not_record: 1 of 4 sessions (25.00%).
- tool_durations / capped: 1 of 4 sessions (25.00%).

### Plugin versions

- desk 3.2.0-alpha.47: 1 session.
- desk 3.2.0-alpha.48: 3 sessions.
- plain-language 1.0.0-alpha.3: 1 session.
