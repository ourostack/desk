import { makeSessionLabelProposal } from "../../mcp/src/runtime/session-label.js"

const unavailable = (code) => ({ state: "unavailable", code })
const mainEvent = (event) => event.agentId === undefined &&
  event.data?.agentId === undefined && event.data?.parentToolCallId === undefined
const taskTools = new Map([["task_focus", "focused"], ["task_create", "created"], ["task_update", "updated"]])

function toolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent
  try { return JSON.parse(result?.content) } catch { return null }
}

// The session handle is obtained only through the host's parent-loaded
// joinSession(). Nothing is recovered from transcripts, card titles or disk.
export async function attachCopilotSessionLabels({
  session, expectedSessionId, serverName = "desk", timeoutMs = 2000, onState = () => {},
}) {
  let state = unavailable("awaiting_task_observation")
  let revision = 0
  let pending = null
  let stopped = false
  let unsubscribe = () => {}
  let queue = Promise.resolve()
  const publish = (value) => {
    state = { ...value }
    // A failed display observer must not affect task execution or naming.
    try { onState({ ...state }) } catch {}
  }
  const bounded = async (operation) => {
    let timer
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(Error("native_timeout"), { code: "NATIVE_TIMEOUT" })), timeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
  const active = (observation) => !stopped && observation.revision === revision
  const dispose = async () => {
    stopped = true
    revision++
    pending = null
    unsubscribe()
    await queue
  }
  const consumer = {
    dispose,
    waitForIdle: () => queue,
    getState: () => ({ ...state }),
  }
  const failure = (error, applying = false) => {
    if (applying && error?.code !== -32601) {
      // An unacknowledged write may still complete. Do not issue another
      // automatic write that it could overtake, or claim a retry was safe.
      stopped = true
      unsubscribe()
      publish(unavailable("native_apply_uncertain"))
    } else publish(unavailable(error?.code === -32601 ? "unsupported_runtime" : "native_api_failed"))
  }
  if (!expectedSessionId || session?.sessionId !== expectedSessionId) {
    publish(unavailable("owner_unknown"))
    return consumer
  }
  if (typeof session.on !== "function" ||
      typeof session.rpc?.metadata?.snapshot !== "function" ||
      typeof session.rpc?.name?.setAuto !== "function" ||
      typeof session.rpc?.name?.get !== "function") {
    publish(unavailable("unsupported_runtime"))
    return consumer
  }
  try {
    if ((await bounded(() => session.rpc.metadata.snapshot())).sessionId !== expectedSessionId) {
      publish(unavailable("owner_unknown"))
      return consumer
    }
  } catch (error) { failure(error); return consumer }

  const apply = async (observation, proposal) => {
    if (!active(observation)) return
    let applying = false
    try {
      const identity = await bounded(() => session.rpc.metadata.snapshot())
      if (!active(observation)) return
      if (identity.sessionId !== expectedSessionId || session.sessionId !== expectedSessionId) {
        publish(unavailable("owner_unknown"))
        return
      }
      applying = true
      const result = await bounded(() => session.rpc.name.setAuto({ summary: proposal.text }))
      applying = false
      if (!active(observation)) return
      if (result?.applied !== true) {
        publish({ state: "preserved", code: "native_owner_refused" })
        return
      }
      const readback = await bounded(() => session.rpc.name.get())
      if (!active(observation)) return
      publish(readback?.name === proposal.text
        ? { state: "applied", code: "native_readback_verified" }
        : unavailable("native_readback_mismatch"))
    } catch (error) {
      if ((applying && error?.code !== -32601) || active(observation)) failure(error, applying)
    }
  }

  unsubscribe = session.on((event) => {
    if (stopped || !mainEvent(event)) return
    if (event.type === "session.shutdown") { void dispose(); return }
    if (event.type === "session.resume") {
      revision++
      pending = null
      publish(unavailable("awaiting_task_observation"))
      return
    }
    const data = event.data
    if (event.type === "tool.execution_start") {
      if ((data?.mcpConfigServerName ?? data?.mcpServerName) !== serverName ||
          !taskTools.has(data.mcpToolName) || typeof data.toolCallId !== "string") return
      revision++
      pending = { revision, id: data.toolCallId, tool: data.mcpToolName, args: { ...data.arguments } }
      return
    }
    if (event.type !== "tool.execution_complete" || !pending || data?.toolCallId !== pending.id) return
    const observation = pending
    pending = null
    if (data.success !== true) return
    const result = toolResult(data.result)
    if (result?.status !== taskTools.get(observation.tool)) return
    if (observation.tool === "task_create" && result.focused !== true) return
    const { track, slug, display_label: displayLabel } = observation.args
    const checked = makeSessionLabelProposal({ task: { track, slug }, displayLabel })
    const proposal = result.session_label?.proposal
    if (!checked.proposal || !proposal || proposal.version !== 1 || proposal.phase !== "unknown" ||
        proposal.origin !== "automatic" || proposal.text !== checked.proposal.text ||
        proposal.task?.track !== track || proposal.task?.slug !== slug) {
      publish(unavailable("missing_current_safe_proposal"))
      return
    }
    queue = queue.then(() => apply(observation, checked.proposal))
  })
  return consumer
}
