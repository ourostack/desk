# Factory report index

## Jobs

| Job | Lead time | Active time | Active before card | Flow efficiency |
| --- | ---: | ---: | ---: | ---: |
| aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | 14000 ms (measured) | 14000 ms (measured) | 1000 ms (measured) | 92.86% (measured, inferred evidence) |
| bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb | 12000 ms (partial: the job was still open when this was measured) | 8000 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered) | 0 ms (partial: it was cut to a size limit and the source could not be read; 1 session uncovered) | 66.67% (partial: it was cut to a size limit and the job was still open when this was measured and the source could not be read; 1 session uncovered; inferred evidence) |

Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time. Each number carries its state: measured, partial with its reason, or not recorded.

Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.

## Coverage

- Sessions seen: not recorded (the store only receives published facts, so it cannot count sessions that never published any).
- Sessions with facts: 4 (measured).
- Bound sessions: 3 (measured).
- Unattributed sessions: 1 (measured).
- Host claude-code: 2 sessions (measured).
- Host copilot-cli: 2 sessions (measured).

### Unavailable evidence

- API retries: the host records only some of it, so this is a lower bound (2 of 4 sessions, 50.00%).
- Commits: the host does not record it (2 of 4 sessions, 50.00%).
- Compaction wait time: the host does not record it (2 of 4 sessions, 50.00%).
- Session end time: the session was still open (1 of 4 sessions, 25.00%).
- Human waits: the host does not record it (1 of 4 sessions, 25.00%).
- Job clock offsets: the source could not be read (1 of 4 sessions, 25.00%).
- Models: the host's record did not include it (1 of 4 sessions, 25.00%); the host does not record it (1 of 4 sessions, 25.00%).
- Permission waits: the host does not record it (2 of 4 sessions, 50.00%).
- Pull requests: the host records only some of it, so this is a lower bound (4 of 4 sessions, 100.00%).
- Reasoning tokens: the host does not record it (2 of 4 sessions, 50.00%).
- Model requests: the host's record did not include it (2 of 4 sessions, 50.00%).
- Tokens: the host's record did not include it (1 of 4 sessions, 25.00%); the host does not record it (1 of 4 sessions, 25.00%).
- Tool durations: it was cut to a size limit (1 of 4 sessions, 25.00%).

### Plugin versions

- desk 3.2.0-alpha.47: 1 session (measured).
- desk 3.2.0-alpha.48: 3 sessions (measured).
- plain-language 1.0.0-alpha.3: 1 session (measured).
