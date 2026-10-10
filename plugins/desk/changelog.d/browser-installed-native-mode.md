### Fixed

- Real-profile browser launch works when a plugin installer preserves native executable bytes but not executable mode bits. Desk copies the current-host hash-verified asset into its existing private launch attempt, establishes owner-only execution there, verifies the copy, and preflights it before use. Shared installed assets remain unchanged, and exact attempt cleanup includes the private executable.
