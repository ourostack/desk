export function requestArchiveTerminalBeforeDeadline(deadline, request) {
  if (Date.now() < deadline) return request()
  console.error("desk_factory: archive_terminal_requests_deferred_deadline")
}
