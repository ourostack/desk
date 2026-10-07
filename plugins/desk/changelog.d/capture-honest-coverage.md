### Capture coverage no longer raises false alarms on the public factory site

A capture record that was wrong stayed on the site for 20 hours, and Copilot CLI and Codex sessions that no desk owned were counted against the one store as misses. Both showed up as "less than 80% of capturable sessions were captured".

A record whose captured share for a host differs by 0.15 or more from the last record sent is now sent at the next flush instead of waiting out the 20 hours, so a corrected record replaces a wrong one at once. A normal small change still waits. The share of the last record sent is kept as `sent_share` in the local `status.json` capture bookkeeping (a ratio per host, never a count, and never published).

The coverage pass is no longer recorded while it can only measure a transient state. If a quarantine folder changed in the last 5 minutes, or the quarantine holds files and more than half of a host's sessions on disk are `held`, the previous coverage stays and the sweep reports `kept`. Before this, a pass taken during a quarantine release counted every quarantined copy as `held`, not `derived`, and that record was published.

For a host that cannot tell a non-desk session from a miss (its `not_in_a_desk` is null), an unowned session that no marker names is no longer counted as `not_seen` in a store's record. It is left out as unknown, so the store reads the host's share as unavailable or computed from owned sessions only, never as a low one. Owned sessions are counted as before. No emitted field is removed or renamed, and no field is added to the published record.
