// A registry shaped like Desk's src/tool-names.js.
export const TOOL_NAMES = [
  "task_create",
  "desk_search",
]

export const TOOL_DESCRIPTIONS = Object.freeze({
  task_create: "Create a task card.",
  desk_search: "Search the desk.",
})

export const TOOL_ANNOTATIONS = Object.freeze({
  desk_search: { readOnlyHint: true },
})
