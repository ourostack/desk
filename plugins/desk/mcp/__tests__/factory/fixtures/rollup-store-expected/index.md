# Factory report index

## Jobs

| Job | Lead time | Active time | Active before card | Flow efficiency |
| --- | ---: | ---: | ---: | ---: |
| 11111111111111111111111111111111 | 10000 ms (measured) | 8000 ms (measured) | 0 ms (measured) | 80.00% (inferred) |
| 22222222222222222222222222222222 | 25000 ms (measured) | 17000 ms (measured) | 0 ms (measured) | 68.00% (inferred) |
| 33333333333333333333333333333333 | 18000 ms (measured) | 12000 ms (measured) | 0 ms (measured) | 66.67% (inferred) |
| 44444444444444444444444444444444 | 8000 ms (measured, censored) | 7000 ms (measured) | 0 ms (measured) | 87.50% (inferred, censored) |
| 55555555555555555555555555555555 | unavailable (cancelled) | 8000 ms (measured) | 0 ms (measured) | unavailable (cancelled) |
| 66666666666666666666666666666666 | 10000 ms (measured) | 7000 ms (measured) | 0 ms (measured) | 70.00% (inferred) |

Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time.

Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.

## Coverage

- Sessions seen: unavailable (not_reported_to_store).
- Sessions with facts: 10.
- Bound sessions: 9.
- Unattributed sessions: 1.
- Host claude-code: 5 sessions.
- Host copilot-cli: 5 sessions.

### Unavailable evidence

- human_waits / host_does_not_record: 5 of 10 sessions (50.00%).
- permission_waits / host_does_not_record: 5 of 10 sessions (50.00%).

### Plugin versions

- desk 3.2.0-alpha.70: 3 sessions.
- desk 3.2.0-alpha.71: 7 sessions.
