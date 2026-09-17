export const READINESS_PROTOCOL_VERSION = 1

export function requestMessage({ id, method, params = {} }) {
  return { type: "request", id, method, params }
}

export function responseMessage({ id, result, error }) {
  return error === undefined
    ? { type: "response", id, result }
    : { type: "response", id, error }
}
