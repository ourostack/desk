# Factory rollups

Totals and distributions across jobs, grouped by plugin version, host, job class and waste type; tool kinds are summed per session. They name no person, machine, date or time of day.

Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded because the job is not finished. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions, is excluded and listed with its reason, never counted as zero. Jobs counted reads n of N: the jobs whose value counted, of all jobs in the group, open ones included. Compactions (count) is how many compactions happened, which every host records; compaction wait time is a different number and is recorded only where the host records it. Every group has a state: measured when n equals N, partial when some jobs counted, and not recorded when none did, in which case there is no median. A value the host records only partly is a lower bound, so it is left out of n and listed under its reason. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.

## Waste by type

Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each job counts only its own part of a session, so a session several jobs share counts once in a total. The unknown row, once any label could say it, is time the evaluator looked at and could not tell: it is not counted in muda time, but each row's share is of all labeled waste time, unknown included. Confidence is the time in the row by how sure the evaluator was; it reads not recorded when a label that speaks to the row is from an evaluator that recorded none. Evaluator versions are the versions of those labels.

### All jobs

Muda time: 14000 ms (partial) across 4 of 6 jobs fully labeled; excluded: the job is not finished (1 job), only some sessions supplied it (1 job). Sessions summed: 6, each job's own part once; shared by several jobs: 0.

| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| waiting | 8000 ms | 57.14% | 57.14% | 4 | not recorded | 3.1.1 |
| defects | 4000 ms | 28.57% | 85.71% | 2 | not recorded | 3.1.1 |
| extra_processing | 2000 ms | 14.29% | 100.00% | 1 | not recorded | 3.1.1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| motion | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| transportation | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |

### By job class: other

Muda time: 14000 ms (partial) across 4 of 6 jobs fully labeled; excluded: the job is not finished (1 job), only some sessions supplied it (1 job). Sessions summed: 6, each job's own part once; shared by several jobs: 0.

| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| waiting | 8000 ms | 57.14% | 57.14% | 4 | not recorded | 3.1.1 |
| defects | 4000 ms | 28.57% | 85.71% | 2 | not recorded | 3.1.1 |
| extra_processing | 2000 ms | 14.29% | 100.00% | 1 | not recorded | 3.1.1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| motion | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| transportation | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |

### By plugin version: 3.1.0

Muda time: 9000 ms (measured) across 2 of 2 jobs fully labeled; excluded: none. Sessions summed: 2, each job's own part once; shared by several jobs: 0.

| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| waiting | 5000 ms | 55.56% | 55.56% | 2 | not recorded | 3.1.1 |
| defects | 2000 ms | 22.22% | 77.78% | 1 | not recorded | 3.1.1 |
| extra_processing | 2000 ms | 22.22% | 100.00% | 1 | not recorded | 3.1.1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| motion | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| transportation | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |

### By plugin version: 3.1.1

Muda time: 4000 ms (partial) across 1 of 3 jobs fully labeled; excluded: the job is not finished (1 job), only some sessions supplied it (1 job). Sessions summed: 2, each job's own part once; shared by several jobs: 0.

| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| defects | 2000 ms | 50.00% | 50.00% | 1 | not recorded | 3.1.1 |
| waiting | 2000 ms | 50.00% | 100.00% | 1 | not recorded | 3.1.1 |
| extra_processing | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| motion | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| transportation | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |

### By plugin version: mixed

Muda time: 1000 ms (measured) across 1 of 1 jobs fully labeled; excluded: none. Sessions summed: 2, each job's own part once; shared by several jobs: 0.

| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| waiting | 1000 ms | 100.00% | 100.00% | 1 | not recorded | 3.1.1 |
| defects | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| extra_processing | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| inventory | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| motion | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| non_utilized_talent | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| overproduction | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |
| transportation | 0 ms | 0.00% | 100.00% | 0 | not recorded | 3.1.1 |

## Measures

Quality measures, which andon watches first, are marked (quality).

### All jobs

Jobs: 6; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 4 of 6 | 10000 ms | 18000 ms | the job was cancelled (1 job), the job is not finished (1 job) |
| queue_before_start | partial | 5 of 6 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 5 of 6 | 8000 ms | 12000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 4 of 6 | 68.00% | 70.00% | the job was cancelled (1 job), the job is not finished (1 job) |
| human_wait | partial | 2 of 6 | 2000 ms | 2000 ms | the host does not record it (2 jobs), the job is not finished (1 job), only some sessions supplied it (1 job) |
| permission_wait | partial | 2 of 6 | 0 ms | 2000 ms | the host does not record it (2 jobs), the job is not finished (1 job), only some sessions supplied it (1 job) |
| api_retry_wait | partial | 2 of 6 | 0 ms | 1000 ms | the host records only some of it, so this is a lower bound (3 jobs), the job is not finished (1 job) |
| tool_failures (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| api_retries (quality) | partial | 2 of 6 | 0 | 1 | the host records only some of it, so this is a lower bound (3 jobs), the job is not finished (1 job) |
| compactions (count) | partial | 5 of 6 | 0 | 0 | the job is not finished (1 job) |
| retouches (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| muda_time | partial | 4 of 6 | 4000 ms | 4000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | partial | 4 of 6 | 0 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | partial | 4 of 6 | 2000 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 6 | not recorded | not recorded | published facts do not carry it (5 jobs), the job is not finished (1 job) |

### By plugin version: 3.1.0

Jobs: 2; open, and so left out of every measure: 0.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | measured | 2 of 2 | 10000 ms | 25000 ms | none |
| queue_before_start | measured | 2 of 2 | 0 ms | 5000 ms | none |
| active_time | measured | 2 of 2 | 8000 ms | 17000 ms | none |
| flow_efficiency | measured | 2 of 2 | 68.00% | 80.00% | none |
| human_wait | partial | 1 of 2 | 2000 ms | 2000 ms | the host does not record it (1 job) |
| permission_wait | partial | 1 of 2 | 2000 ms | 2000 ms | the host does not record it (1 job) |
| api_retry_wait | partial | 1 of 2 | 1000 ms | 1000 ms | the host records only some of it, so this is a lower bound (1 job) |
| tool_failures (quality) | measured | 2 of 2 | 1 | 1 | none |
| tool_retries (quality) | measured | 2 of 2 | 1 | 2 | none |
| api_retries (quality) | partial | 1 of 2 | 1 | 1 | the host records only some of it, so this is a lower bound (1 job) |
| compactions (count) | measured | 2 of 2 | 0 | 0 | none |
| retouches (quality) | measured | 2 of 2 | 0 | 0 | none |
| muda_time | measured | 2 of 2 | 4000 ms | 5000 ms | none |
| muda_time.defects (quality) | measured | 2 of 2 | 0 ms | 2000 ms | none |
| muda_time.overproduction | measured | 2 of 2 | 0 ms | 0 ms | none |
| muda_time.waiting | measured | 2 of 2 | 2000 ms | 3000 ms | none |
| muda_time.non_utilized_talent | measured | 2 of 2 | 0 ms | 0 ms | none |
| muda_time.transportation | measured | 2 of 2 | 0 ms | 0 ms | none |
| muda_time.inventory | measured | 2 of 2 | 0 ms | 0 ms | none |
| muda_time.motion | measured | 2 of 2 | 0 ms | 0 ms | none |
| muda_time.extra_processing | measured | 2 of 2 | 0 ms | 2000 ms | none |
| search_waste | not recorded | 0 of 2 | not recorded | not recorded | published facts do not carry it (2 jobs) |

### By plugin version: 3.1.1

Jobs: 3; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 1 of 3 | 18000 ms | 18000 ms | the job was cancelled (1 job), the job is not finished (1 job) |
| queue_before_start | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 2 of 3 | 8000 ms | 12000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 1 of 3 | 66.67% | 66.67% | the job was cancelled (1 job), the job is not finished (1 job) |
| human_wait | partial | 1 of 3 | 2000 ms | 2000 ms | the host does not record it (1 job), the job is not finished (1 job) |
| permission_wait | partial | 1 of 3 | 0 ms | 0 ms | the host does not record it (1 job), the job is not finished (1 job) |
| api_retry_wait | partial | 1 of 3 | 0 ms | 0 ms | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| tool_failures (quality) | partial | 2 of 3 | 0 | 1 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 2 of 3 | 0 | 1 | the job is not finished (1 job) |
| api_retries (quality) | partial | 1 of 3 | 0 | 0 | the host records only some of it, so this is a lower bound (1 job), the job is not finished (1 job) |
| compactions (count) | partial | 2 of 3 | 0 | 1 | the job is not finished (1 job) |
| retouches (quality) | partial | 2 of 3 | 1 | 1 | the job is not finished (1 job) |
| muda_time | partial | 1 of 3 | 4000 ms | 4000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | partial | 1 of 3 | 2000 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | partial | 1 of 3 | 2000 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | partial | 1 of 3 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 3 | not recorded | not recorded | published facts do not carry it (2 jobs), the job is not finished (1 job) |

### By plugin version: mixed

Jobs: 1; open, and so left out of every measure: 0.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | measured | 1 of 1 | 10000 ms | 10000 ms | none |
| queue_before_start | measured | 1 of 1 | 0 ms | 0 ms | none |
| active_time | measured | 1 of 1 | 7000 ms | 7000 ms | none |
| flow_efficiency | measured | 1 of 1 | 70.00% | 70.00% | none |
| human_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| tool_failures (quality) | measured | 1 of 1 | 0 | 0 | none |
| tool_retries (quality) | measured | 1 of 1 | 0 | 0 | none |
| api_retries (quality) | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| compactions (count) | measured | 1 of 1 | 0 | 0 | none |
| retouches (quality) | measured | 1 of 1 | 1 | 1 | none |
| muda_time | measured | 1 of 1 | 1000 ms | 1000 ms | none |
| muda_time.defects (quality) | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.overproduction | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.waiting | measured | 1 of 1 | 1000 ms | 1000 ms | none |
| muda_time.non_utilized_talent | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.transportation | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.inventory | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.motion | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.extra_processing | measured | 1 of 1 | 0 ms | 0 ms | none |
| search_waste | not recorded | 0 of 1 | not recorded | not recorded | published facts do not carry it (1 job) |

### By host: claude-code

Jobs: 3; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 2 of 3 | 10000 ms | 18000 ms | the job is not finished (1 job) |
| queue_before_start | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 2 of 3 | 8000 ms | 12000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 2 of 3 | 66.67% | 80.00% | the job is not finished (1 job) |
| human_wait | partial | 2 of 3 | 2000 ms | 2000 ms | the job is not finished (1 job) |
| permission_wait | not recorded | 0 of 3 | not recorded | not recorded | the host does not record it (2 jobs), the job is not finished (1 job) |
| api_retry_wait | not recorded | 0 of 3 | not recorded | not recorded | the host records only some of it, so this is a lower bound (2 jobs), the job is not finished (1 job) |
| tool_failures (quality) | partial | 2 of 3 | 1 | 1 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 2 of 3 | 1 | 1 | the job is not finished (1 job) |
| api_retries (quality) | not recorded | 0 of 3 | not recorded | not recorded | the host records only some of it, so this is a lower bound (2 jobs), the job is not finished (1 job) |
| compactions (count) | partial | 2 of 3 | 0 | 1 | the job is not finished (1 job) |
| retouches (quality) | partial | 2 of 3 | 0 | 1 | the job is not finished (1 job) |
| muda_time | partial | 2 of 3 | 4000 ms | 4000 ms | the job is not finished (1 job) |
| muda_time.defects (quality) | partial | 2 of 3 | 2000 ms | 2000 ms | the job is not finished (1 job) |
| muda_time.overproduction | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| muda_time.waiting | partial | 2 of 3 | 2000 ms | 2000 ms | the job is not finished (1 job) |
| muda_time.non_utilized_talent | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| muda_time.transportation | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| muda_time.inventory | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| muda_time.motion | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| muda_time.extra_processing | partial | 2 of 3 | 0 ms | 0 ms | the job is not finished (1 job) |
| search_waste | not recorded | 0 of 3 | not recorded | not recorded | published facts do not carry it (2 jobs), the job is not finished (1 job) |

### By host: copilot-cli

Jobs: 2; open, and so left out of every measure: 0.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 1 of 2 | 25000 ms | 25000 ms | the job was cancelled (1 job) |
| queue_before_start | measured | 2 of 2 | 0 ms | 5000 ms | none |
| active_time | measured | 2 of 2 | 8000 ms | 17000 ms | none |
| flow_efficiency | partial | 1 of 2 | 68.00% | 68.00% | the job was cancelled (1 job) |
| human_wait | not recorded | 0 of 2 | not recorded | not recorded | the host does not record it (2 jobs) |
| permission_wait | measured | 2 of 2 | 0 ms | 2000 ms | none |
| api_retry_wait | measured | 2 of 2 | 0 ms | 1000 ms | none |
| tool_failures (quality) | measured | 2 of 2 | 0 | 1 | none |
| tool_retries (quality) | measured | 2 of 2 | 0 | 2 | none |
| api_retries (quality) | measured | 2 of 2 | 0 | 1 | none |
| compactions (count) | measured | 2 of 2 | 0 | 0 | none |
| retouches (quality) | measured | 2 of 2 | 0 | 1 | none |
| muda_time | partial | 1 of 2 | 5000 ms | 5000 ms | only some sessions supplied it (1 job) |
| muda_time.defects (quality) | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.overproduction | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.waiting | partial | 1 of 2 | 3000 ms | 3000 ms | only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.transportation | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.inventory | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.motion | partial | 1 of 2 | 0 ms | 0 ms | only some sessions supplied it (1 job) |
| muda_time.extra_processing | partial | 1 of 2 | 2000 ms | 2000 ms | only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 2 | not recorded | not recorded | published facts do not carry it (2 jobs) |

### By host: mixed

Jobs: 1; open, and so left out of every measure: 0.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | measured | 1 of 1 | 10000 ms | 10000 ms | none |
| queue_before_start | measured | 1 of 1 | 0 ms | 0 ms | none |
| active_time | measured | 1 of 1 | 7000 ms | 7000 ms | none |
| flow_efficiency | measured | 1 of 1 | 70.00% | 70.00% | none |
| human_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| permission_wait | not recorded | 0 of 1 | not recorded | not recorded | only some sessions supplied it (1 job) |
| api_retry_wait | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| tool_failures (quality) | measured | 1 of 1 | 0 | 0 | none |
| tool_retries (quality) | measured | 1 of 1 | 0 | 0 | none |
| api_retries (quality) | not recorded | 0 of 1 | not recorded | not recorded | the host records only some of it, so this is a lower bound (1 job) |
| compactions (count) | measured | 1 of 1 | 0 | 0 | none |
| retouches (quality) | measured | 1 of 1 | 1 | 1 | none |
| muda_time | measured | 1 of 1 | 1000 ms | 1000 ms | none |
| muda_time.defects (quality) | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.overproduction | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.waiting | measured | 1 of 1 | 1000 ms | 1000 ms | none |
| muda_time.non_utilized_talent | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.transportation | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.inventory | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.motion | measured | 1 of 1 | 0 ms | 0 ms | none |
| muda_time.extra_processing | measured | 1 of 1 | 0 ms | 0 ms | none |
| search_waste | not recorded | 0 of 1 | not recorded | not recorded | published facts do not carry it (1 job) |

### By job class: other

Jobs: 6; open, and so left out of every measure: 1.

| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |
| --- | --- | ---: | ---: | ---: | --- |
| lead_time | partial | 4 of 6 | 10000 ms | 18000 ms | the job was cancelled (1 job), the job is not finished (1 job) |
| queue_before_start | partial | 5 of 6 | 0 ms | 0 ms | the job is not finished (1 job) |
| active_time | partial | 5 of 6 | 8000 ms | 12000 ms | the job is not finished (1 job) |
| flow_efficiency | partial | 4 of 6 | 68.00% | 70.00% | the job was cancelled (1 job), the job is not finished (1 job) |
| human_wait | partial | 2 of 6 | 2000 ms | 2000 ms | the host does not record it (2 jobs), the job is not finished (1 job), only some sessions supplied it (1 job) |
| permission_wait | partial | 2 of 6 | 0 ms | 2000 ms | the host does not record it (2 jobs), the job is not finished (1 job), only some sessions supplied it (1 job) |
| api_retry_wait | partial | 2 of 6 | 0 ms | 1000 ms | the host records only some of it, so this is a lower bound (3 jobs), the job is not finished (1 job) |
| tool_failures (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| tool_retries (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| api_retries (quality) | partial | 2 of 6 | 0 | 1 | the host records only some of it, so this is a lower bound (3 jobs), the job is not finished (1 job) |
| compactions (count) | partial | 5 of 6 | 0 | 0 | the job is not finished (1 job) |
| retouches (quality) | partial | 5 of 6 | 1 | 1 | the job is not finished (1 job) |
| muda_time | partial | 4 of 6 | 4000 ms | 4000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.defects (quality) | partial | 4 of 6 | 0 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.overproduction | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.waiting | partial | 4 of 6 | 2000 ms | 2000 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.non_utilized_talent | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.transportation | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.inventory | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.motion | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| muda_time.extra_processing | partial | 4 of 6 | 0 ms | 0 ms | the job is not finished (1 job), only some sessions supplied it (1 job) |
| search_waste | not recorded | 0 of 6 | not recorded | not recorded | published facts do not carry it (5 jobs), the job is not finished (1 job) |

## Tool kinds

Calls and failures summed over 10 sessions with facts, each session counted once; most failures first.

| Tool kind | State | Calls | Failures | Sessions counted (n of N) | Why not whole |
| --- | --- | ---: | ---: | ---: | --- |
| shell | measured | 4 | 2 | 2 of 2 | none |
| edit | measured | 3 | 1 | 1 of 1 | none |
| search | measured | 2 | 1 | 2 of 2 | none |
| read | measured | 1 | 0 | 1 of 1 | none |

## Sign-off

Sign-off: not recorded in any session of this store.

## First-pass yield

- First-pass yield: not recorded (no delivered job has a first-pass result yet).
- Left out of the count: 6 jobs (no outcome record is available).

## Rework

- Rework: not recorded (no outcome record is available).

## Human attention

- Human attention per accepted outcome: no accepted outcomes yet, and no human attention is recorded in the period (no session in the store records the human's turns).
- Human turns per accepted outcome: no accepted outcomes yet.
- Sessions in the period: 0, of which 0 record the human's turns completely. Sessions from before turns were recorded are not in the period.
- Permission decisions, reported beside the headline and not in it: 1, estimated at 2 seconds (partial: the host does not record it).
- Method: version 1. An estimate of the time the human spent reading the reply and writing the prompt, never longer than the gap before the prompt, and at least 1 second per turn. Reading a reply by size: none 0 ms, xs 1 second, s 5 seconds, m 30 seconds, l 2.5 minutes, xl 6.7 minutes. Writing a prompt by size: none 2 seconds, xs 3 seconds, s 25 seconds, m 2.5 minutes, l 3 minutes, xl 3 minutes. A permission decision counts at most 5 seconds.

## Coverage

- Jobs: 6; open: 1.
- Unattributed sessions: 1 of 10 (3000 ms of 70000 ms session time).
- Jobs fully labeled: 4; partially labeled: 1; unlabeled: 0.
- Labels files: 9; used: 7; unused: the labeled evidence no longer matches the facts (1 file), the session's facts are missing (1 file).
- Job class: every job is other; published facts do not carry the task card's kind.
- Search waste: unavailable; published facts do not carry the organization signal.
