A task card's factory report link no longer names a job ID the store does not publish, and a public desk's card no longer links its job at all. Only a desk known to be private (its cached visibility is `private` or `internal`) gets `factory_report`, to its plain job ID, which is what its store publishes. Any other desk's store job is keyed so that nobody can tie the desk's public cards to it, and a link would make that tie, so its card gets no link. The card instead records `factory_report_unavailable` with a reason code only: `desk_not_private`, `visibility_not_known` (the cached visibility answer is expired, absent or unreadable) or `job_identity_unavailable`. `task_update` and `task_archive` return the same field. A missing link is not permanent: any later `task_update` of such a card asks again, writes the link and removes the field once a link can be named, and otherwise keeps the reason current. A newer answer also removes an older link the card carried. `factory job-link` follows the same rule and prints the reason when there is no link ([factory local capture](docs/factory-local-capture.md)).

Job credit is more accurate:

- A card renamed by Git rename detection is followed only when both sides record the same `created` date. A rename pairing two different cards (a delete plus a new card) no longer joins them.
- Focus on a task merged into another follows the merge to the card that kept it.
- Time the segment cap gives to another task now counts in `segments_capped_ms`, not only time it drops.
- A human turn whose stop precedes its start is dropped and flagged `source_unreadable`, not counted as a negative window.
- A token total missing from several sessions counts each session once, not only the larger part's count.
- The binder version is now 6, so every session derived by an older binder is derived once more, and no older receipt's credit or `segments_capped_ms: 0` is read as this binder's.

`factory reconcile` reports truer reasons:

- A full own-activity list (500 spans) is read as cut, under the new reason `own_activity_cut`.
- A stale binding now says why the session was not rebuilt (`orphan_host_not_rebuilt`, `orphan_derive_failed`, `orphan_crew_desk`, `orphan_route_unknown`).
- Tied store observations that disagree are counted as unordered instead of being picked silently.
- Totals name their keys `sessions` and `sessions_not_recorded`.

The sign-off scan now reports why a count is partial (`archive_cap` or `cards_unreadable`), and a card whose head was cut before its `status` reads as unreadable. The session-start line then says that not every card was read. A task returned from `done` drops its delivery evidence. `task_archive` checks a card's status record before moving any folder, so a damaged card is refused with nothing moved.
