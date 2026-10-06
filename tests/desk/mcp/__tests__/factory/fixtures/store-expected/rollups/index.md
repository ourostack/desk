# Factory rollups

Totals and distributions across jobs, grouped by plugin version, host, job class and waste type; tool kinds are summed per session. They name no person, machine, date or time of day.

Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded because the job is not finished. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions, is excluded and listed with its reason, never counted as zero. Jobs counted reads n of N: the jobs whose value counted, of all jobs in the group, open ones included. Compactions (count) is how many compactions happened, which every host records; compaction wait time is a different number and is recorded only where the host records it. Every group has a state: measured when n equals N, partial when some jobs counted, and not recorded when none did, in which case there is no median. A value the host records only partly is a lower bound, so it is left out of n and listed under its reason. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.

## Waste by type

Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each session's waste counts once in a total, even when several jobs share the session.

### All jobs

No fully labeled finished job yet (not recorded): 0 of 2 jobs fully labeled; excluded: the job is not finished (1 job), only some sessions supplied it (1 job).

### By job class: other

No fully labeled finished job yet (not recorded): 0 of 2 jobs fully labeled; excluded: the job is not finished (1 job), only some sessions supplied it (1 job).

### By plugin version: 3.2.0-alpha.48

No fully labeled finished job yet (not recorded): 0 of 1 jobs fully labeled; excluded: only some sessions supplied it (1 job).

### By plugin version: mixed

No fully labeled finished job yet (not recorded): 0 of 1 jobs fully labeled; excluded: the job is not finished (1 job).

## Measures

Quality measures, which andon watches first, are marked (quality).

### All jobs

Jobs: 2; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| queue_before_start | partial | 1 of 2 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 1 of 2 | 92.86% | 92.86% | the job is not finished (1 job) |
| human_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| tool_failures (quality) | partial | 1 of 2 | 2 | 2 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 1 of 2 | 3 | 3 | the job is not finished (1 job) |
| api_retries (quality) | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| compactions (count) | partial | 1 of 2 | 0 | 0 | the job is not finished (1 job) |
| retouches (quality) | partial | 1 of 2 | 1 | 1 | the job is not finished (1 job) |
| muda_time | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 2 | not recorded | not recorded | published facts do not carry it (1 job), the job is not finished (1 job) |

### By plugin version: 3.2.0-alpha.48

Jobs: 1; open, and so left out of every measure: 0.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | measured | 1 of 1 | 14000 ms | 14000 ms | none |
| queue_before_start | measured | 1 of 1 | 0 ms | 0 ms | none |
| active_time | measured | 1 of 1 | 14000 ms | 14000 ms | none |
| flow_efficiency | measured | 1 of 1 | 92.86% | 92.86% | none |
| human_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| tool_failures (quality) | measured | 1 of 1 | 2 | 2 | none |
| tool_retries (quality) | measured | 1 of 1 | 3 | 3 | none |
| api_retries (quality) | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| compactions (count) | measured | 1 of 1 | 0 | 0 | none |
| retouches (quality) | measured | 1 of 1 | 1 | 1 | none |
| muda_time | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.defects (quality) | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.overproduction | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.waiting | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.transportation | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.inventory | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.motion | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| muda_time.extra_processing | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 1 | not recorded | not recorded | published facts do not carry it (1 job) |

### By plugin version: mixed

Jobs: 1; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| queue_before_start | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| active_time | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| flow_efficiency | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| human_wait | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| permission_wait | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| api_retry_wait | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| tool_failures (quality) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| tool_retries (quality) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| api_retries (quality) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| compactions (count) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| retouches (quality) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.defects (quality) | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.overproduction | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.waiting | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.non_utilized_talent | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.transportation | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.inventory | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.motion | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| muda_time.extra_processing | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |
| search_waste | not recorded | 0 of 1 | not recorded | not recorded | the job is not finished (1 job) |

### By host: mixed

Jobs: 2; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| queue_before_start | partial | 1 of 2 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 1 of 2 | 92.86% | 92.86% | the job is not finished (1 job) |
| human_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| tool_failures (quality) | partial | 1 of 2 | 2 | 2 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 1 of 2 | 3 | 3 | the job is not finished (1 job) |
| api_retries (quality) | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| compactions (count) | partial | 1 of 2 | 0 | 0 | the job is not finished (1 job) |
| retouches (quality) | partial | 1 of 2 | 1 | 1 | the job is not finished (1 job) |
| muda_time | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 2 | not recorded | not recorded | published facts do not carry it (1 job), the job is not finished (1 job) |

### By job class: other

Jobs: 2; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| queue_before_start | partial | 1 of 2 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 1 of 2 | 14000 ms | 14000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 1 of 2 | 92.86% | 92.86% | the job is not finished (1 job) |
| human_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| tool_failures (quality) | partial | 1 of 2 | 2 | 2 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 1 of 2 | 3 | 3 | the job is not finished (1 job) |
| api_retries (quality) | not recorded | 0 of 2 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| compactions (count) | partial | 1 of 2 | 0 | 0 | the job is not finished (1 job) |
| retouches (quality) | partial | 1 of 2 | 1 | 1 | the job is not finished (1 job) |
| muda_time | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | not recorded | 0 of 2 | not recorded | not recorded | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 2 | not recorded | not recorded | published facts do not carry it (1 job), the job is not finished (1 job) |

## Tool kinds

Calls and failures summed over 4 sessions with facts, each session counted once; most failures first.

| Tool kind | State | Calls | Failures | Sessions counted (n of N) | Why not whole |
| --- | --- | ---: | ---: | ---: | --- |
| edit | measured | 3 | 1 | 1 of 1 | none |
| shell | measured | 2 | 1 | 1 of 1 | none |
| agent | measured | 2 | 0 | 2 of 2 | none |
| search | measured | 1 | 0 | 1 of 1 | none |
| read | not recorded | not recorded | not recorded | 0 of 1 | it was cut to a size limit |

## Coverage

- Jobs: 2; open: 1.
- Unattributed sessions: 1 of 4 (4000 ms of 36000 ms session time).
- Jobs fully labeled: 0; partially labeled: 1; unlabeled: 0.
- Labels files: 1; used: 1; unused: none.
- Job class: every job is other; published facts do not carry the task card's kind.
- Search waste: unavailable; published facts do not carry the organization signal.
