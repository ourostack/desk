import { makeSessionLabelProposal } from "../../mcp/src/runtime/session-label.js"
import { readFileSync } from "node:fs"

const unavailable = (code) => ({ state: "unavailable", code })
const mainEvent = (event) => event.agentId === undefined &&
  event.data?.agentId === undefined && event.data?.parentToolCallId === undefined
const taskTools = new Map([["task_focus", "focused"], ["task_create", "created"], ["task_update", "updated"]])
class NativeTimeout extends Error {}

// Diagnostics come only from this fixed vocabulary, never from a native
// error's text, data or stack. An error that cannot be read safely is
// `failed`; that cause deliberately does not claim a transport fault.
const methodMissing = (error) => {
  try { return error?.code === -32601 } catch { return false }
}
const failureCause = (error) => {
  try {
    if (error instanceof NativeTimeout) return "timeout"
    const code = error?.code
    if (code === -32602) return "invalid_params"
    if (code === -32603) return "internal_error"
    if (Number.isInteger(code) && code >= -32768 && code <= -32000) return "rpc_error"
  } catch {}
  return "failed"
}

function toolResult(result) {
  if (result?.structuredContent && typeof result.structuredContent === "object") return result.structuredContent
  try { return JSON.parse(result?.content) } catch { return null }
}

// The session handle is obtained only through the host's parent-loaded
// joinSession(). Nothing is recovered from transcripts, card titles or disk.
export async function attachCopilotSessionLabels({
  session, expectedSessionId, serverName = "desk", timeoutMs = 2000, orderingBudgetMs = 1000, onState = () => {},
}) {
  let state = unavailable("awaiting_task_observation")
  let revision = 0
  let pending = null
  let admission = null
  let providerAdmitted = false
  let stopped = false
  let unsubscribe = () => {}
  let queue = Promise.resolve()
  const publish = (value) => {
    state = { ...value }
    // A failed display observer must not affect task execution or naming.
    try { onState({ ...state }) } catch {}
  }
  const bounded = async (operation, budgetMs = timeoutMs) => {
    let timer
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new NativeTimeout("native_timeout"), { code: "NATIVE_TIMEOUT" })), budgetMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
  // This is the provider shape observed in the normally configured, locally
  // acquired Desk-plugin host. Other activation/agent owners are not denied
  // Desk access: absent equivalent host ownership, only naming is unavailable.
  const boundProvider = async () => {
    if (typeof session.rpc?.mcp?.listConfigured !== "function") return false
    try {
      const owner = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"))
      const servers = (await bounded(() => session.rpc.mcp.listConfigured())).servers
        .filter((server) => server.name === serverName)
      return servers.length === 1 && servers[0].source === "plugin" &&
        servers[0].sourcePlugin === owner.name && servers[0].sourcePluginVersion === owner.version
    } catch { return false }
  }
  const active = (observation) => !stopped && observation.revision === revision
  const dispose = async () => {
    stopped = true
    revision++
    pending = null
    admission = null
    unsubscribe()
    await queue
  }
  const beforeMcpToolCall = async (input, invocation) => {
    if (stopped || !providerAdmitted || input?.sessionId !== expectedSessionId ||
        invocation?.sessionId !== expectedSessionId || input.agentId !== undefined ||
        input.parentAgentId !== undefined || input.serverName !== serverName ||
        !taskTools.has(input.toolName)) return
    if (typeof input.toolCallId !== "string") return
    admission = null
    if (pending?.id !== input.toolCallId) {
      revision++
      pending = null
    }
    try {
      const budget = Number.isFinite(orderingBudgetMs) ? Math.max(1, Math.min(1000, orderingBudgetMs)) : 1000
      await bounded(() => queue, budget)
    } catch {
      // A display failure is never a permission decision or a work ban. Stop
      // naming, make uncertainty explicit, and let the MCP request continue.
      stopped = true
      revision++
      pending = null
      admission = null
      unsubscribe()
      publish(unavailable("native_apply_uncertain"))
      return
    }
    if (stopped) return
    admission = { id: input.toolCallId, tool: input.toolName }
    if (pending?.id === admission.id && pending.tool === admission.tool) pending.admitted = true
    // Deliberately no metaToUse or permission output.
  }
  const consumer = {
    dispose,
    beforeMcpToolCall,
    waitForIdle: () => queue,
    getState: () => ({ ...state }),
  }
  const failure = (stage, error, current = true) => {
    const missing = methodMissing(error)
    if (stage === "apply" && !missing) {
      // An unacknowledged write may still complete. Do not issue another
      // automatic write that it could overtake, or claim a retry was safe.
      stopped = true
      unsubscribe()
      publish(unavailable("native_apply_uncertain"))
    } else if (current) {
      publish(unavailable(missing ? "unsupported_runtime" : `native_${stage}_${failureCause(error)}`))
    }
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
  } catch (error) { failure("snapshot", error); return consumer }
  if (!await boundProvider()) {
    publish(unavailable("provider_binding_unavailable"))
    return consumer
  }
  providerAdmitted = true

  const apply = async (observation, proposal) => {
    if (!active(observation)) return
    let stage = "recheck"
    try {
      const providerKnown = await boundProvider()
      if (!active(observation)) return
      if (!providerKnown) {
        publish(unavailable("provider_binding_unavailable"))
        return
      }
      const identity = await bounded(() => session.rpc.metadata.snapshot())
      if (!active(observation)) return
      if (identity.sessionId !== expectedSessionId || session.sessionId !== expectedSessionId) {
        publish(unavailable("owner_unknown"))
        return
      }
      stage = "apply"
      const result = await bounded(() => session.rpc.name.setAuto({ summary: proposal.text }))
      stage = "readback"
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
      failure(stage, error, active(observation))
    }
  }

  unsubscribe = session.on((event) => {
    if (stopped || !mainEvent(event)) return
    if (event.type === "session.shutdown") { void dispose(); return }
    if (event.type === "session.resume") {
      revision++
      pending = null
      admission = null
      publish(unavailable("awaiting_task_observation"))
      return
    }
    const data = event.data
    if (event.type === "tool.execution_start") {
      if ((data?.mcpConfigServerName ?? data?.mcpServerName) !== serverName ||
          !taskTools.has(data.mcpToolName) || typeof data.toolCallId !== "string") return
      if (data.mcpConfigSource !== "plugin") {
        publish(unavailable("provider_binding_unavailable"))
        return
      }
      revision++
      pending = {
        revision, id: data.toolCallId, tool: data.mcpToolName, args: { ...data.arguments },
        admitted: admission?.id === data.toolCallId && admission.tool === data.mcpToolName,
      }
      return
    }
    if (event.type !== "tool.execution_complete" || !pending || data?.toolCallId !== pending.id) return
    const observation = pending
    pending = null
    if (admission?.id === observation.id) admission = null
    if (data.success !== true) return
    if (!observation.admitted) {
      publish(unavailable("native_ordering_unavailable"))
      return
    }
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
