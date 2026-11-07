### Fixed

- Preserve sync outcomes when the authoritative status lock is unavailable or its retained record cannot be read safely. A lock's age no longer authorizes an unlocked overwrite, and successful outgoing delivery no longer clears an incoming pull outcome. This safety milestone does not qualify complete tracked-history recovery. A lock whose owner on this host has exited is still taken over, so a crash inside the update cannot freeze the record.
