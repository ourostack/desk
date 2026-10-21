import { joinSession } from "@github/copilot-sdk/extension"
import { attachCopilotSessionLabels } from "./consumer.mjs"

// The native extension owner discovers this entry before the session starts.
// Never start/resume an independent SDK client or request sensitive variables.
try {
  const session = await joinSession()
  const consumer = await attachCopilotSessionLabels({
    session,
    expectedSessionId: process.env.SESSION_ID,
    onState: (state) => {
      const message = `Desk automatic session label: ${state.state}/${state.code}`
      void session.log(message, { level: state.state === "unavailable" ? "warning" : "info" }).catch(() => {})
    },
  })
  process.once("SIGTERM", () => {
    void consumer.dispose().then(() => session.disconnect()).finally(() => process.exit(0))
  })
} catch {
  // stdout belongs to the parent's JSON-RPC transport; never log input,
  // proposal text, provider errors or native identity here.
  process.stderr.write("Desk automatic session labels unavailable: unsupported_runtime\n")
}
