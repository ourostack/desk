### Fixed

- Real-profile browser connections launch their official extension connect page directly in a new window, instead of racing a separate holding window against the browser's last-active window. Each connection has a distinct owner label and keeps the existing bounded, connection-scoped cleanup contract.
- Native window launch assets are included for the existing browser platform/architecture combinations and verified against their source and content hashes. Missing, modified or conflicting launch configuration refuses browser operations instead of borrowing another window.
- Exact-owned pages use renderer-only focus emulation through the extension's existing debugger capability, so frames and normal clicks keep working without activating their browser window. An inactive connection-owned control tab preserves this across task-page navigation and closes through the ordinary connection cleanup.
- Real-profile tab selection explicitly refuses foreground activation and explains the supported action-scoped alternative. Cleanup waits for pending operations, while cancelled preparations cannot dispatch after cancellation or shutdown.
