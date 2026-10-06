A task card's factory report link now names the job ID the store actually publishes. A desk known to be private (or internal) still links the plain job ID. Any other desk links the keyed ID, made with this machine's secret, so a public desk never shows a plain job ID. If the desk's visibility is not known or has expired, or the machine secret is missing, the card gets no link (`visibility_not_known` or `machine_secret_unavailable`) instead of a link that might lead nowhere. `factory job-link` follows the same rule and returns the reason when there is no link. Because the keyed ID is per machine, run the check on the machine that did the work ([factory local capture](docs/factory-local-capture.md)).

Job credit is more accurate:

- A card renamed by Git rename detection is followed only when both sides record the same `created` date. A rename pairing two different cards (a delete plus a new card) no longer joins them.
- Focus on a task merged into another follows the merge to the card that kept it.
- Time the segment cap gives to another task now counts in `segments_capped_ms`, not only time it drops.
- A human turn whose stop precedes its start is dropped and flagged `source_unreadable`, not counted as a negative window.
- A token total missing from several sessions counts each session once, not only the larger part's count.

`factory reconcile` reports truer reasons:

- A full own-activity list (500 spans) is read as cut, under the new reason `own_activity_cut`.
- A stale binding now says why the session was not rebuilt (`orphan_host_not_rebuilt`, `orphan_derive_failed`, `orphan_crew_desk`, `orphan_route_unknown`).
- Tied store observations that disagree are counted as unordered instead of being picked silently.
- Totals name their keys `sessions` and `sessions_not_recorded`.

The sign-off scan now reports why a count is partial (`archive_cap` or `cards_unreadable`), and a card whose head was cut before its `status` reads as unreadable. The session-start line then says that not every card was read. A task returned from `done` drops its delivery evidence. `task_archive` checks a card's status record before moving any folder, so a damaged card is refused with nothing moved.
