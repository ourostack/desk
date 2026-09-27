# Factory reports

These files are generated deterministically from validated published session facts.

- `index.md` lists job reports and coverage.
- `jobs/<job>.md` answers the four factory questions.
- `jobs/<job>.json` carries the normalized timeline and classed formulas.
- `rollups/index.md` shows which waste costs the most across jobs and the measure catalog per plugin version, host and job class; `rollups/measures.json`, `rollups/muda.json`, `rollups/tool-kinds.json` and `rollups/coverage.json` carry the same numbers.

Published facts contain durations and offsets only. Missing evidence stays unavailable with its reason, and a value only some sessions could supply is marked partial with the count of uncovered sessions.
