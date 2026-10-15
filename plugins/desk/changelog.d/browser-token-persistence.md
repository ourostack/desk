### Fixed

- Wait up to ten seconds for a newly initialized browser extension token to reach profile storage instead of immediately reporting a missing extension. Existing tokens connect without a delay, and storage errors still surface immediately. Automatic extension provisioning, stale-token rotation and foreground-safe first connection remain separate delivery gates.
