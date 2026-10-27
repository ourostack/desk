// An environment variable's value, looked up the way the platform names variables. Windows treats names without regard
// to case (`APPDATA`, `AppData`), and `process.env` does too, but a plain copy (`{ ...process.env }`, or one sent to a
// worker thread) keeps one spelling, so the tool server and the boot script read different values unless every lookup
// goes through here. Dependency-free: the boot script and hooks run it from the installed plugin.

/** `env[name]` on POSIX; on Windows, the value of the first key equal to `name` ignoring case. */
export function envValue(env, name, platform = process.platform) {
  if (env === null || typeof env !== "object") return undefined
  if (typeof env[name] === "string" || platform !== "win32") return env[name]
  const lower = name.toLowerCase()
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === lower)
  return key === undefined ? undefined : env[key]
}
