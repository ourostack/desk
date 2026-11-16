// The tools whose title, description, input schema and annotations are generated from the declarations in
// actions/*.actions.mts (ouro-actions generate, one folder per file). Dependency-free: JSON imports, read before the runtime pack.
import read from "./generated/desk-read/mcp.json" with { type: "json" }
import session from "./generated/desk-session/mcp.json" with { type: "json" }

export const ACTION_TOOLS = Object.freeze(Object.fromEntries([...read.tools, ...session.tools].map((tool) => [tool.name, Object.freeze(tool)])))
