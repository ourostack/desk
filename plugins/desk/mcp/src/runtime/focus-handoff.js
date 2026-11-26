// The server's end of the focus handoff with the idle proxy (mcp/idle-proxy.cjs), over the private IPC channel the proxy opened for this process, never over MCP stdio.
//
// The proxy asks for the session's focus at an idle stop (`snapshot`) and keeps it in its own memory only; the next server, which says `hello` first, is asked to `restore` it. Every message carries the token the proxy put in this process's environment, so a message from anywhere else is ignored. Nothing here is a tool, appears in tools/list, or writes anything: the session checks the card exists and holds the focus in memory.

const OPS = new Set(["snapshot", "restore", "abort"])

/**
 * @param {{ channel: { on, off?, removeListener?, send, channel?: { unref?: () => void } }, token: string, session: { focusSnapshot, restoreFocus }, kick: () => void, log?: (text: string) => void }} options
 * @returns {() => void} removes this handoff's own listeners and aborts work in flight
 */
export function serveFocusHandoff({ channel, token, session, kick, log = () => {} }) {
  if (typeof token !== "string" || token === "" || typeof channel?.on !== "function" || typeof channel?.send !== "function") return () => {}
  const active = new Map()
  const reply = (message) => {
    try {
      channel.send({ desk: "focus-handoff", v: 1, token, ...message }, () => {})
    } catch (error) {
      log(`focus handoff reply failed: ${error?.code ?? "error"}`)
    }
  }
  const onMessage = (message) => {
    if (message === null || typeof message !== "object" || message.desk !== "focus-handoff" || message.v !== 1 || message.token !== token || !OPS.has(message.op)) return
    if (message.op === "snapshot") {
      let snapshot
      try {
        snapshot = session.focusSnapshot()
      } catch {
        snapshot = null
      }
      reply({ op: "snapshot-result", id: message.id, snapshot })
    } else if (message.op === "abort") {
      active.get(message.id)?.abort()
    } else if (message.op === "restore") {
      // The proxy only restores into a server that has started admission: the restore needs the same admission a tool call would start.
      kick()
      const controller = new AbortController()
      active.set(message.id, controller)
      Promise.resolve()
        .then(() => session.restoreFocus({ snapshot: message.snapshot, unknown: message.unknown }, { budgetMs: message.budgetMs, signal: controller.signal }))
        .catch(() => ({ outcome: "unknown" }))
        .then((result) => {
          active.delete(message.id)
          if (!controller.signal.aborted) reply({ op: "restore-result", id: message.id, outcome: result?.outcome ?? "unknown" })
        })
    }
  }
  const onDisconnect = () => active.forEach((controller) => controller.abort())
  channel.on("message", onMessage)
  channel.on("disconnect", onDisconnect)
  // The channel must not keep this process alive once the host's stdin has ended.
  channel.channel?.unref?.()
  reply({ op: "hello" })
  return () => {
    const remove = channel.off ?? channel.removeListener
    remove?.call(channel, "message", onMessage)
    remove?.call(channel, "disconnect", onDisconnect)
    active.forEach((controller) => controller.abort())
    active.clear()
  }
}
