### Fixed

- Report a missing persisted browser-extension credential without falsely asserting the extension is absent or returning operator install/toolbar/retry instructions. Keep the existing error code and binding. Automatic extension setup is not available through this launcher yet: this is an explicit blocked boundary, not a new provisioning capability.
