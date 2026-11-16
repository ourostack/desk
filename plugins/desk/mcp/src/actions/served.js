// The tools whose title, description, input schema and annotations are generated from the declarations in
// actions/desk-read.actions.mts (ouro-actions generate). Dependency-free: a JSON import, read before the runtime pack.
import generated from "./generated/mcp.json" with { type: "json" }

export const ACTION_TOOLS = Object.freeze(Object.fromEntries(generated.tools.map((tool) => [tool.name, Object.freeze(tool)])))
