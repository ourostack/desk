# Factory rollups

Totals and distributions across jobs, grouped by plugin version, host, job class and waste type; tool kinds are summed per session. They name no person, machine, date or time of day.

Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded as open_job. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions (partial), is excluded and listed with its reason, never counted as zero. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.

## Waste by type

Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each session's waste counts once in a total, even when several jobs share the session.

### All jobs

No fully labeled finished job yet: 0 of 2 jobs fully labeled; excluded: open_job 1, partial 1.

### By job class: other

No fully labeled finished job yet: 0 of 2 jobs fully labeled; excluded: open_job 1, partial 1.

### By plugin version: 3.2.0-alpha.48

No fully labeled finished job yet: 0 of 1 jobs fully labeled; excluded: partial 1.

### By plugin version: mixed

No fully labeled finished job yet: 0 of 1 jobs fully labeled; excluded: open_job 1.

## Measures

Quality measures, which andon watches first, are marked (quality).

### All jobs

Jobs: 2; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| queue_before_start | 1 | 0 ms | 0 ms | open_job 1 |
| active_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| flow_efficiency | 1 | 92.86% | 92.86% | open_job 1 |
| human_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| permission_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| api_retry_wait | 1 | 500 ms | 500 ms | open_job 1 |
| tool_failures (quality) | 1 | 2 | 2 | open_job 1 |
| tool_retries (quality) | 1 | 3 | 3 | open_job 1 |
| api_retries (quality) | 1 | 1 | 1 | open_job 1 |
| compactions | 1 | 0 | 0 | open_job 1 |
| retouches (quality) | 1 | 1 | 1 | open_job 1 |
| muda_time | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.defects (quality) | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.overproduction | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.waiting | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.transportation | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.inventory | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.motion | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.extra_processing | 0 | unavailable | unavailable | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1, open_job 1 |

### By plugin version: 3.2.0-alpha.48

Jobs: 1; open, and so left out of every measure: 0.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 14000 ms | 14000 ms | none |
| queue_before_start | 1 | 0 ms | 0 ms | none |
| active_time | 1 | 14000 ms | 14000 ms | none |
| flow_efficiency | 1 | 92.86% | 92.86% | none |
| human_wait | 0 | unavailable | unavailable | partial 1 |
| permission_wait | 0 | unavailable | unavailable | partial 1 |
| api_retry_wait | 1 | 500 ms | 500 ms | none |
| tool_failures (quality) | 1 | 2 | 2 | none |
| tool_retries (quality) | 1 | 3 | 3 | none |
| api_retries (quality) | 1 | 1 | 1 | none |
| compactions | 1 | 0 | 0 | none |
| retouches (quality) | 1 | 1 | 1 | none |
| muda_time | 0 | unavailable | unavailable | partial 1 |
| muda_time.defects (quality) | 0 | unavailable | unavailable | partial 1 |
| muda_time.overproduction | 0 | unavailable | unavailable | partial 1 |
| muda_time.waiting | 0 | unavailable | unavailable | partial 1 |
| muda_time.non_utilized_talent | 0 | unavailable | unavailable | partial 1 |
| muda_time.transportation | 0 | unavailable | unavailable | partial 1 |
| muda_time.inventory | 0 | unavailable | unavailable | partial 1 |
| muda_time.motion | 0 | unavailable | unavailable | partial 1 |
| muda_time.extra_processing | 0 | unavailable | unavailable | partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1 |

### By plugin version: mixed

Jobs: 1; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 0 | unavailable | unavailable | open_job 1 |
| queue_before_start | 0 | unavailable | unavailable | open_job 1 |
| active_time | 0 | unavailable | unavailable | open_job 1 |
| flow_efficiency | 0 | unavailable | unavailable | open_job 1 |
| human_wait | 0 | unavailable | unavailable | open_job 1 |
| permission_wait | 0 | unavailable | unavailable | open_job 1 |
| api_retry_wait | 0 | unavailable | unavailable | open_job 1 |
| tool_failures (quality) | 0 | unavailable | unavailable | open_job 1 |
| tool_retries (quality) | 0 | unavailable | unavailable | open_job 1 |
| api_retries (quality) | 0 | unavailable | unavailable | open_job 1 |
| compactions | 0 | unavailable | unavailable | open_job 1 |
| retouches (quality) | 0 | unavailable | unavailable | open_job 1 |
| muda_time | 0 | unavailable | unavailable | open_job 1 |
| muda_time.defects (quality) | 0 | unavailable | unavailable | open_job 1 |
| muda_time.overproduction | 0 | unavailable | unavailable | open_job 1 |
| muda_time.waiting | 0 | unavailable | unavailable | open_job 1 |
| muda_time.non_utilized_talent | 0 | unavailable | unavailable | open_job 1 |
| muda_time.transportation | 0 | unavailable | unavailable | open_job 1 |
| muda_time.inventory | 0 | unavailable | unavailable | open_job 1 |
| muda_time.motion | 0 | unavailable | unavailable | open_job 1 |
| muda_time.extra_processing | 0 | unavailable | unavailable | open_job 1 |
| search_waste | 0 | unavailable | unavailable | open_job 1 |

### By host: mixed

Jobs: 2; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| queue_before_start | 1 | 0 ms | 0 ms | open_job 1 |
| active_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| flow_efficiency | 1 | 92.86% | 92.86% | open_job 1 |
| human_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| permission_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| api_retry_wait | 1 | 500 ms | 500 ms | open_job 1 |
| tool_failures (quality) | 1 | 2 | 2 | open_job 1 |
| tool_retries (quality) | 1 | 3 | 3 | open_job 1 |
| api_retries (quality) | 1 | 1 | 1 | open_job 1 |
| compactions | 1 | 0 | 0 | open_job 1 |
| retouches (quality) | 1 | 1 | 1 | open_job 1 |
| muda_time | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.defects (quality) | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.overproduction | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.waiting | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.transportation | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.inventory | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.motion | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.extra_processing | 0 | unavailable | unavailable | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1, open_job 1 |

### By job class: other

Jobs: 2; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| queue_before_start | 1 | 0 ms | 0 ms | open_job 1 |
| active_time | 1 | 14000 ms | 14000 ms | open_job 1 |
| flow_efficiency | 1 | 92.86% | 92.86% | open_job 1 |
| human_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| permission_wait | 0 | unavailable | unavailable | open_job 1, partial 1 |
| api_retry_wait | 1 | 500 ms | 500 ms | open_job 1 |
| tool_failures (quality) | 1 | 2 | 2 | open_job 1 |
| tool_retries (quality) | 1 | 3 | 3 | open_job 1 |
| api_retries (quality) | 1 | 1 | 1 | open_job 1 |
| compactions | 1 | 0 | 0 | open_job 1 |
| retouches (quality) | 1 | 1 | 1 | open_job 1 |
| muda_time | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.defects (quality) | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.overproduction | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.waiting | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.transportation | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.inventory | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.motion | 0 | unavailable | unavailable | open_job 1, partial 1 |
| muda_time.extra_processing | 0 | unavailable | unavailable | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1, open_job 1 |

## Tool kinds

Calls and failures summed over 4 sessions with facts, each session counted once; most failures first.

| Tool kind | Calls | Failures | Sessions |
| --- | ---: | ---: | ---: |
| edit | 3 | 1 | 1 |
| shell | 2 | 1 | 1 |
| agent | 2 | 0 | 2 |
| read | 1 | 0 | 1 |
| search | 1 | 0 | 1 |

## Coverage

- Jobs: 2; open: 1.
- Unattributed sessions: 1 of 4 (4000 ms of 36000 ms session time).
- Jobs fully labeled: 0; partially labeled: 1; unlabeled: 0.
- Labels files: 1; used: 1; unused: none.
- Job class: every job is other; published facts do not carry the task card's kind.
- Search waste: unavailable; published facts do not carry the organization signal.
