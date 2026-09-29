The factory intake now delivers files it used to leave frozen, and its local diagnostics agree with the store.

Quarantine records now keep the sha of the blob the factory store refused. A flush now retries a quarantined facts file when its published blob differs from the refused one, so files frozen by an older Desk or a stale refusal are delivered again; a held file whose repository visibility cannot be resolved stays quarantined without blocking other files. The local jobs index now mirrors the outbox: a re-derive that drops a job removes it, and existing indexes are rebuilt once.
