// Resolve what admission needs from the launch arguments, the environment and the activation config: the desk root, the activation context, the runtime cache, the readiness policy and the state branch.
//
// Kept apart from index.js so the admission worker can run it off the thread that answers the host: importing index.js would start Desk.

import * as path from "node:path"
import { normalizeReadinessPolicy } from "../activation/readiness-policy.js"
import {
  expandHome,
  loadActivationConfig,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "../util/paths.js"

export function resolveStartupDeskRoot({ args, env = process.env, homeDir } = {}) {
  return resolveDeskRootWithSource({
    activationConfigPath: resolveStartupActivationConfigPath({ args, env }),
    env,
    explicitRoot: args?.root,
    homeDir,
    hostProjectRoot: env.CLAUDE_PROJECT_DIR,
    hostSessionRoot: args?.hostSessionRoot,
  })
}

export function resolveStartupActivationConfigPath({ args, env = process.env } = {}) {
  return resolveActivationConfigPath({ explicit: args?.activationConfig, env })
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
