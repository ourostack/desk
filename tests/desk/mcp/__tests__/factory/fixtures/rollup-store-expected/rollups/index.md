# Factory rollups

Totals and distributions across jobs, grouped by plugin version, host, job class and waste type; tool kinds are summed per session. They name no person, machine, date or time of day.

Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded as open_job. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions (partial), is excluded and listed with its reason, never counted as zero. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.

## Waste by type

Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each session's waste counts once in a total, even when several jobs share the session.

### All jobs

Muda time: 14000 ms across 4 of 6 jobs fully labeled; excluded: open_job 1, partial 1. Sessions summed: 6, each once; shared by several jobs: 0.

| Waste | Muda time | Share | Cumulative | Jobs |
| --- | ---: | ---: | ---: | ---: |
| waiting | 8000 ms | 57.14% | 57.14% | 4 |
| defects | 4000 ms | 28.57% | 85.71% | 2 |
| extra_processing | 2000 ms | 14.29% | 100.00% | 1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 |
| motion | 0 ms | 0.00% | 100.00% | 0 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 |
| transportation | 0 ms | 0.00% | 100.00% | 0 |

### By job class: other

Muda time: 14000 ms across 4 of 6 jobs fully labeled; excluded: open_job 1, partial 1. Sessions summed: 6, each once; shared by several jobs: 0.

| Waste | Muda time | Share | Cumulative | Jobs |
| --- | ---: | ---: | ---: | ---: |
| waiting | 8000 ms | 57.14% | 57.14% | 4 |
| defects | 4000 ms | 28.57% | 85.71% | 2 |
| extra_processing | 2000 ms | 14.29% | 100.00% | 1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 |
| motion | 0 ms | 0.00% | 100.00% | 0 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 |
| transportation | 0 ms | 0.00% | 100.00% | 0 |

### By plugin version: 3.1.0

Muda time: 9000 ms across 2 of 2 jobs fully labeled; excluded: none. Sessions summed: 2, each once; shared by several jobs: 0.

| Waste | Muda time | Share | Cumulative | Jobs |
| --- | ---: | ---: | ---: | ---: |
| waiting | 5000 ms | 55.56% | 55.56% | 2 |
| defects | 2000 ms | 22.22% | 77.78% | 1 |
| extra_processing | 2000 ms | 22.22% | 100.00% | 1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 |
| motion | 0 ms | 0.00% | 100.00% | 0 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 |
| transportation | 0 ms | 0.00% | 100.00% | 0 |

### By plugin version: 3.1.1

Muda time: 4000 ms across 1 of 3 jobs fully labeled; excluded: open_job 1, partial 1. Sessions summed: 2, each once; shared by several jobs: 0.

| Waste | Muda time | Share | Cumulative | Jobs |
| --- | ---: | ---: | ---: | ---: |
| defects | 2000 ms | 50.00% | 50.00% | 1 |
| waiting | 2000 ms | 50.00% | 100.00% | 1 |
| extra_processing | 0 ms | 0.00% | 100.00% | 0 |
| inventory | 0 ms | 0.00% | 100.00% | 0 |
| motion | 0 ms | 0.00% | 100.00% | 0 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 |
| transportation | 0 ms | 0.00% | 100.00% | 0 |

### By plugin version: mixed

Muda time: 1000 ms across 1 of 1 jobs fully labeled; excluded: none. Sessions summed: 2, each once; shared by several jobs: 0.

| Waste | Muda time | Share | Cumulative | Jobs |
| --- | ---: | ---: | ---: | ---: |
| waiting | 1000 ms | 100.00% | 100.00% | 1 |
| defects | 0 ms | 0.00% | 100.00% | 0 |
| extra_processing | 0 ms | 0.00% | 100.00% | 0 |
| inventory | 0 ms | 0.00% | 100.00% | 0 |
| motion | 0 ms | 0.00% | 100.00% | 0 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 |
| transportation | 0 ms | 0.00% | 100.00% | 0 |

## Measures

Quality measures, which andon watches first, are marked (quality).

### All jobs

Jobs: 6; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 4 | 10000 ms | 18000 ms | cancelled 1, open_job 1 |
| queue_before_start | 5 | 0 ms | 0 ms | open_job 1 |
| active_time | 5 | 8000 ms | 12000 ms | open_job 1 |
| flow_efficiency | 4 | 68.00% | 70.00% | cancelled 1, open_job 1 |
| human_wait | 2 | 2000 ms | 2000 ms | host_does_not_record 2, open_job 1, partial 1 |
| permission_wait | 2 | 0 ms | 2000 ms | host_does_not_record 2, open_job 1, partial 1 |
| api_retry_wait | 5 | 0 ms | 1000 ms | open_job 1 |
| tool_failures (quality) | 5 | 1 | 1 | open_job 1 |
| tool_retries (quality) | 5 | 1 | 1 | open_job 1 |
| api_retries (quality) | 5 | 0 | 1 | open_job 1 |
| compactions | 5 | 0 | 0 | open_job 1 |
| retouches (quality) | 5 | 1 | 1 | open_job 1 |
| muda_time | 4 | 4000 ms | 4000 ms | open_job 1, partial 1 |
| muda_time.defects (quality) | 4 | 0 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.overproduction | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.waiting | 4 | 2000 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.transportation | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.inventory | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.motion | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.extra_processing | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 5, open_job 1 |

### By plugin version: 3.1.0

Jobs: 2; open, and so left out of every measure: 0.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 2 | 10000 ms | 25000 ms | none |
| queue_before_start | 2 | 0 ms | 5000 ms | none |
| active_time | 2 | 8000 ms | 17000 ms | none |
| flow_efficiency | 2 | 68.00% | 80.00% | none |
| human_wait | 1 | 2000 ms | 2000 ms | host_does_not_record 1 |
| permission_wait | 1 | 2000 ms | 2000 ms | host_does_not_record 1 |
| api_retry_wait | 2 | 0 ms | 1000 ms | none |
| tool_failures (quality) | 2 | 1 | 1 | none |
| tool_retries (quality) | 2 | 1 | 2 | none |
| api_retries (quality) | 2 | 0 | 1 | none |
| compactions | 2 | 0 | 0 | none |
| retouches (quality) | 2 | 0 | 0 | none |
| muda_time | 2 | 4000 ms | 5000 ms | none |
| muda_time.defects (quality) | 2 | 0 ms | 2000 ms | none |
| muda_time.overproduction | 2 | 0 ms | 0 ms | none |
| muda_time.waiting | 2 | 2000 ms | 3000 ms | none |
| muda_time.non_utilized_talent | 2 | 0 ms | 0 ms | none |
| muda_time.transportation | 2 | 0 ms | 0 ms | none |
| muda_time.inventory | 2 | 0 ms | 0 ms | none |
| muda_time.motion | 2 | 0 ms | 0 ms | none |
| muda_time.extra_processing | 2 | 0 ms | 2000 ms | none |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 2 |

### By plugin version: 3.1.1

Jobs: 3; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 18000 ms | 18000 ms | cancelled 1, open_job 1 |
| queue_before_start | 2 | 0 ms | 0 ms | open_job 1 |
| active_time | 2 | 8000 ms | 12000 ms | open_job 1 |
| flow_efficiency | 1 | 66.67% | 66.67% | cancelled 1, open_job 1 |
| human_wait | 1 | 2000 ms | 2000 ms | host_does_not_record 1, open_job 1 |
| permission_wait | 1 | 0 ms | 0 ms | host_does_not_record 1, open_job 1 |
| api_retry_wait | 2 | 0 ms | 0 ms | open_job 1 |
| tool_failures (quality) | 2 | 0 | 1 | open_job 1 |
| tool_retries (quality) | 2 | 0 | 1 | open_job 1 |
| api_retries (quality) | 2 | 0 | 0 | open_job 1 |
| compactions | 2 | 0 | 1 | open_job 1 |
| retouches (quality) | 2 | 1 | 1 | open_job 1 |
| muda_time | 1 | 4000 ms | 4000 ms | open_job 1, partial 1 |
| muda_time.defects (quality) | 1 | 2000 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.overproduction | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.waiting | 1 | 2000 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.transportation | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.inventory | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.motion | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.extra_processing | 1 | 0 ms | 0 ms | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 2, open_job 1 |

### By plugin version: mixed

Jobs: 1; open, and so left out of every measure: 0.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 10000 ms | 10000 ms | none |
| queue_before_start | 1 | 0 ms | 0 ms | none |
| active_time | 1 | 7000 ms | 7000 ms | none |
| flow_efficiency | 1 | 70.00% | 70.00% | none |
| human_wait | 0 | unavailable | unavailable | partial 1 |
| permission_wait | 0 | unavailable | unavailable | partial 1 |
| api_retry_wait | 1 | 1000 ms | 1000 ms | none |
| tool_failures (quality) | 1 | 0 | 0 | none |
| tool_retries (quality) | 1 | 0 | 0 | none |
| api_retries (quality) | 1 | 1 | 1 | none |
| compactions | 1 | 0 | 0 | none |
| retouches (quality) | 1 | 1 | 1 | none |
| muda_time | 1 | 1000 ms | 1000 ms | none |
| muda_time.defects (quality) | 1 | 0 ms | 0 ms | none |
| muda_time.overproduction | 1 | 0 ms | 0 ms | none |
| muda_time.waiting | 1 | 1000 ms | 1000 ms | none |
| muda_time.non_utilized_talent | 1 | 0 ms | 0 ms | none |
| muda_time.transportation | 1 | 0 ms | 0 ms | none |
| muda_time.inventory | 1 | 0 ms | 0 ms | none |
| muda_time.motion | 1 | 0 ms | 0 ms | none |
| muda_time.extra_processing | 1 | 0 ms | 0 ms | none |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1 |

### By host: claude-code

Jobs: 3; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 2 | 10000 ms | 18000 ms | open_job 1 |
| queue_before_start | 2 | 0 ms | 0 ms | open_job 1 |
| active_time | 2 | 8000 ms | 12000 ms | open_job 1 |
| flow_efficiency | 2 | 66.67% | 80.00% | open_job 1 |
| human_wait | 2 | 2000 ms | 2000 ms | open_job 1 |
| permission_wait | 0 | unavailable | unavailable | host_does_not_record 2, open_job 1 |
| api_retry_wait | 2 | 0 ms | 0 ms | open_job 1 |
| tool_failures (quality) | 2 | 1 | 1 | open_job 1 |
| tool_retries (quality) | 2 | 1 | 1 | open_job 1 |
| api_retries (quality) | 2 | 0 | 0 | open_job 1 |
| compactions | 2 | 0 | 1 | open_job 1 |
| retouches (quality) | 2 | 0 | 1 | open_job 1 |
| muda_time | 2 | 4000 ms | 4000 ms | open_job 1 |
| muda_time.defects (quality) | 2 | 2000 ms | 2000 ms | open_job 1 |
| muda_time.overproduction | 2 | 0 ms | 0 ms | open_job 1 |
| muda_time.waiting | 2 | 2000 ms | 2000 ms | open_job 1 |
| muda_time.non_utilized_talent | 2 | 0 ms | 0 ms | open_job 1 |
| muda_time.transportation | 2 | 0 ms | 0 ms | open_job 1 |
| muda_time.inventory | 2 | 0 ms | 0 ms | open_job 1 |
| muda_time.motion | 2 | 0 ms | 0 ms | open_job 1 |
| muda_time.extra_processing | 2 | 0 ms | 0 ms | open_job 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 2, open_job 1 |

### By host: copilot-cli

Jobs: 2; open, and so left out of every measure: 0.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 25000 ms | 25000 ms | cancelled 1 |
| queue_before_start | 2 | 0 ms | 5000 ms | none |
| active_time | 2 | 8000 ms | 17000 ms | none |
| flow_efficiency | 1 | 68.00% | 68.00% | cancelled 1 |
| human_wait | 0 | unavailable | unavailable | host_does_not_record 2 |
| permission_wait | 2 | 0 ms | 2000 ms | none |
| api_retry_wait | 2 | 0 ms | 1000 ms | none |
| tool_failures (quality) | 2 | 0 | 1 | none |
| tool_retries (quality) | 2 | 0 | 2 | none |
| api_retries (quality) | 2 | 0 | 1 | none |
| compactions | 2 | 0 | 0 | none |
| retouches (quality) | 2 | 0 | 1 | none |
| muda_time | 1 | 5000 ms | 5000 ms | partial 1 |
| muda_time.defects (quality) | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.overproduction | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.waiting | 1 | 3000 ms | 3000 ms | partial 1 |
| muda_time.non_utilized_talent | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.transportation | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.inventory | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.motion | 1 | 0 ms | 0 ms | partial 1 |
| muda_time.extra_processing | 1 | 2000 ms | 2000 ms | partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 2 |

### By host: mixed

Jobs: 1; open, and so left out of every measure: 0.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 1 | 10000 ms | 10000 ms | none |
| queue_before_start | 1 | 0 ms | 0 ms | none |
| active_time | 1 | 7000 ms | 7000 ms | none |
| flow_efficiency | 1 | 70.00% | 70.00% | none |
| human_wait | 0 | unavailable | unavailable | partial 1 |
| permission_wait | 0 | unavailable | unavailable | partial 1 |
| api_retry_wait | 1 | 1000 ms | 1000 ms | none |
| tool_failures (quality) | 1 | 0 | 0 | none |
| tool_retries (quality) | 1 | 0 | 0 | none |
| api_retries (quality) | 1 | 1 | 1 | none |
| compactions | 1 | 0 | 0 | none |
| retouches (quality) | 1 | 1 | 1 | none |
| muda_time | 1 | 1000 ms | 1000 ms | none |
| muda_time.defects (quality) | 1 | 0 ms | 0 ms | none |
| muda_time.overproduction | 1 | 0 ms | 0 ms | none |
| muda_time.waiting | 1 | 1000 ms | 1000 ms | none |
| muda_time.non_utilized_talent | 1 | 0 ms | 0 ms | none |
| muda_time.transportation | 1 | 0 ms | 0 ms | none |
| muda_time.inventory | 1 | 0 ms | 0 ms | none |
| muda_time.motion | 1 | 0 ms | 0 ms | none |
| muda_time.extra_processing | 1 | 0 ms | 0 ms | none |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 1 |

### By job class: other

Jobs: 6; open, and so left out of every measure: 1.

| Measure | Jobs counted | Median | p75 | Excluded |
| --- | ---: | ---: | ---: | --- |
| lead_time | 4 | 10000 ms | 18000 ms | cancelled 1, open_job 1 |
| queue_before_start | 5 | 0 ms | 0 ms | open_job 1 |
| active_time | 5 | 8000 ms | 12000 ms | open_job 1 |
| flow_efficiency | 4 | 68.00% | 70.00% | cancelled 1, open_job 1 |
| human_wait | 2 | 2000 ms | 2000 ms | host_does_not_record 2, open_job 1, partial 1 |
| permission_wait | 2 | 0 ms | 2000 ms | host_does_not_record 2, open_job 1, partial 1 |
| api_retry_wait | 5 | 0 ms | 1000 ms | open_job 1 |
| tool_failures (quality) | 5 | 1 | 1 | open_job 1 |
| tool_retries (quality) | 5 | 1 | 1 | open_job 1 |
| api_retries (quality) | 5 | 0 | 1 | open_job 1 |
| compactions | 5 | 0 | 0 | open_job 1 |
| retouches (quality) | 5 | 1 | 1 | open_job 1 |
| muda_time | 4 | 4000 ms | 4000 ms | open_job 1, partial 1 |
| muda_time.defects (quality) | 4 | 0 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.overproduction | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.waiting | 4 | 2000 ms | 2000 ms | open_job 1, partial 1 |
| muda_time.non_utilized_talent | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.transportation | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.inventory | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.motion | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| muda_time.extra_processing | 4 | 0 ms | 0 ms | open_job 1, partial 1 |
| search_waste | 0 | unavailable | unavailable | not_in_published_facts 5, open_job 1 |

## Tool kinds

Calls and failures summed over 10 sessions with facts, each session counted once; most failures first.

| Tool kind | Calls | Failures | Sessions |
| --- | ---: | ---: | ---: |
| shell | 4 | 2 | 2 |
| edit | 3 | 1 | 1 |
| search | 2 | 1 | 2 |
| read | 1 | 0 | 1 |

## Coverage

- Jobs: 6; open: 1.
- Unattributed sessions: 1 of 10 (3000 ms of 70000 ms session time).
- Jobs fully labeled: 4; partially labeled: 1; unlabeled: 0.
- Labels files: 9; used: 7; unused: evidence_unmatched 1, facts_missing 1.
- Job class: every job is other; published facts do not carry the task card's kind.
- Search waste: unavailable; published facts do not carry the organization signal.
