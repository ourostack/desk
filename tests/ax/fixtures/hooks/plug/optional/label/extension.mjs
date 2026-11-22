import { joinSession } from "@github/copilot-sdk/extension"
await joinSession({
  hooks: {
    onPreMcpToolCall: async () => {},
  },
})
