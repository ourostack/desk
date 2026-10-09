// Resolve what admission needs from the launch arguments, the environment and the activation config: the desk root, the activation context, the runtime cache, the readiness policy and the state branch.
//
// Kept apart from index.js so the admission worker can run it off the thread that answers the host: importing index.js would start Desk.

import * as path from "node:path"
import { normalizeReadinessPolicy } from "../activation/readiness-policy.js"
import { readCopilotSession } from "./copilot-session.js"
import {
  expandHome,
  loadActivationConfig,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"

// The project folder the host opened. Copilot's `sessionStart` hook records it for the session (see copilot-session.js), and that record is this session's own, so it comes first: a CLAUDE_PROJECT_DIR that Copilot inherited from the shell that launched it (for example from inside a Claude Code session) must not override it. Without a record, Claude Code passes the folder in the environment.
function hostProjectFolder(env) {
  return readCopilotSession({ env })?.folder ?? (hasText(env.CLAUDE_PROJECT_DIR) ? env.CLAUDE_PROJECT_DIR : undefined)
}

export function resolveStartupDeskRoot({ args, env = process.env, homeDir, cwd } = {}) {
  return resolveDeskRootWithSource({
    activationConfigPath: resolveStartupActivationConfigPath({ args, env }),
    cwd,
    env,
    explicitRoot: args?.root,
    homeDir,
    // Captured launch evidence is a hint only when the host supplied no project context.
    hostProjectRoot: hostProjectFolder(env) ?? cwd,
    hostSessionRoot: args?.hostSessionRoot,
  })
}

// The server's own configuration first; then the saved binding Copilot's hook saw, because Copilot keeps its plugin data folder out of the server's environment.
export function resolveStartupActivationConfigPath({ args, env = process.env } = {}) {
  return resolveActivationConfigPath({ explicit: args?.activationConfig, env }) ?? readCopilotSession({ env })?.activationConfig ?? null
}

export function resolveStartupRuntimeCacheDir({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (!hasText(loadedActivationConfig.runtimeCacheDir)) {
    return null
  }
  const expanded = expandHome(loadedActivationConfig.runtimeCacheDir, homeDir)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

export function resolveStartupActivationContext({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (loadedActivationConfig?.activation === null || typeof loadedActivationConfig?.activation !== "object") {
    return null
  }
  return {
    ...loadedActivationConfig.activation,
    source: "activation-config",
  }
}

export function resolveStartupSourceIdentity(activationStatus) {
  for (const value of [
    activationStatus?.source_identity,
    activationStatus?.resolved_commit,
    activationStatus?.commit,
    activationStatus?.source?.commit,
  ]) {
    if (hasText(value)) {
      return value
    }
  }
  return null
}

export function resolveStartupReadinessPolicy({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return normalizeReadinessPolicy()
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  return normalizeReadinessPolicy(
    loadedActivationConfig.desk_runtime
      ?? loadedActivationConfig.desk?.runtime
      ?? {},
  )
}

// The state branch a host asks Desk to hold the desk checkout on: `--state-branch <name>`, else `desk.state_branch` in the activation config, else none.
export function resolveStartupStateBranch({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  if (hasText(args?.stateBranch)) return args.stateBranch
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) return null
  const stateBranch = loadActivationConfig({ configPath: activationConfig, cwd, homeDir }).desk.state_branch
  return hasText(stateBranch) ? stateBranch : null
}


function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}
