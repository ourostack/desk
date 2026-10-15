import { realpathSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

/** Validate against the realm's authoritative real desk, without exposing private paths in errors. */
export function isolatedDeskRoot(root, env = process.env) {
  try {
    if (typeof env.DESK !== "string" || !path.isAbsolute(env.DESK) || typeof root !== "string" || !path.isAbsolute(root)) throw new Error()
    const desk = realpathSync(env.DESK)
    const target = realpathSync(root)
    if (target !== desk && !target.startsWith(path.join(desk, path.sep))) throw new Error()
    return root
  } catch {
    throw Object.assign(new Error("Desk Git context refused: root is not within the isolated hosted desk"), { code: "DESK_GIT_CONTEXT_REFUSED" })
  }
}

/** Local/legacy spawn seams retain their exact argv/options; private context travels only in cwd/env. */
export function deskGitInvocation({ root, args, env = process.env }) {
  if (env.DESK_ISOLATED_HOSTED !== "1") return { args: ["-C", root, ...args], options: {} }
  isolatedDeskRoot(root, env)
  return { args, options: { cwd: root } }
}

/** The admitted source mirror itself can be private; even its script filename travels in env. */
export function deskScriptInvocation({ script, args, env }) {
  if (env.DESK_ISOLATED_HOSTED !== "1") return { args: [script, ...args], options: { env } }
  return {
    args: ["--input-type=module", "--eval", 'process.argv.splice(1, 0, "desk-builtin"); await import(process.env.DESK_BUILTIN_SCRIPT)', "--", ...args],
    options: { env: { ...env, DESK_BUILTIN_SCRIPT: pathToFileURL(script).href } },
  }
}

/** Keep fork's IPC/test seam while using the same private module loader as spawned scripts. */
export function deskForkInvocation({ script, env = process.env }) {
  if (env.DESK_ISOLATED_HOSTED !== "1") return { modulePath: script, args: [], options: { execArgv: [] } }
  const invocation = deskScriptInvocation({ script, args: [], env })
  return {
    modulePath: "--",
    args: [],
    options: { ...invocation.options, execArgv: invocation.args.slice(0, -1) },
  }
}
