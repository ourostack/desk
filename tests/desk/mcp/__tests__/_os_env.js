// A test that hands the code under test a hand-built environment (`{ HOME, XDG_STATE_HOME }`) must still give it what the
// operating system itself needs. On Windows that is %SystemRoot%, which Desk uses to find the system PowerShell that
// protects its private stores; a real process always has it. Elsewhere the environment is returned unchanged.
export function osEnv(env = {}) {
  if (process.platform !== "win32") return env
  const inherited = {}
  for (const name of ["SystemRoot", "windir", "ComSpec", "PATHEXT"]) {
    if (process.env[name] !== undefined) inherited[name] = process.env[name]
  }
  return { ...inherited, ...env }
}
