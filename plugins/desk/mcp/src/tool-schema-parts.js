// The building blocks of the tool input schemas (tool-schemas.js).
// Dependency-free, like the schemas themselves.

export const text = (description) => ({ type: "string", description })
export const flag = (description) => ({ type: "boolean", description })
export const integer = (description) => ({ type: "integer", minimum: 1, description })
export const list = (description) => ({ type: "array", items: { type: "string" }, description })
export const oneOf = (options, description) => ({ anyOf: options, description })

export function schema(properties, required = []) {
  return Object.freeze({ type: "object", properties, required, additionalProperties: false })
}
