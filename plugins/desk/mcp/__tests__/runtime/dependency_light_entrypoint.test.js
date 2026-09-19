import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath, pathToFileURL } from "node:url"

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
)
const mcpRoot = path.join(repoRoot, "plugins", "desk", "mcp")
const packageJson = loadJson(path.join(mcpRoot, "package.json"))
const packageLock = loadJson(path.join(mcpRoot, "package-lock.json"))
const hostTarget = `${process.platform}-${process.arch}-node-${process.versions.modules}`
const productionLockHash = productionDependencyLockHash({ packageJson, packageLock })
const hostRuntimePackDir = path.join(
  mcpRoot,
  "artifacts",
  "runtime-deps",
  packageJson.version,
  hostTarget,
  productionLockHash,
)
const hostRuntimePackExists = existsSync(path.join(hostRuntimePackDir, "runtime-deps.tgz"))
const productionDependencyNames = [
  "@modelcontextprotocol/sdk",
  "better-sqlite3",
  "gray-matter",
  "sqlite-vec",
]

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function productionDependencyLockHash({ packageJson, packageLock }) {
  const dependencies = collectAllSupportedProductionDependencies({ packageJson, packageLock })
  return sha256(stableStringify({
    dependencies: packageJson.dependencies ?? {},
    lock_entries: dependencies.map((dependency) => ({
      name: dependency.name,
      lock_path: dependency.lock_path,
      native: dependency.native,
      package: relevantLockFields(packageLock.packages[dependency.lock_path]),
    })),
  }))
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function collectAllSupportedProductionDependencies({ packageJson, packageLock }) {
  const supportedTargets = [
    { platform: "darwin", arch: "arm64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "arm64" },
    { platform: "linux", arch: "x64" },
    { platform: "win32", arch: "x64" },
  ]
  const byLockPath = new Map()
  for (const target of supportedTargets) {
    for (const dependency of collectProductionDependencyClosure({ packageJson, packageLock, ...target })) {
      byLockPath.set(dependency.lock_path, dependency)
    }
  }
  return [...byLockPath.values()].sort((left, right) => left.lock_path.localeCompare(right.lock_path))
}

function collectProductionDependencyClosure({ packageJson, packageLock, platform, arch }) {
  const queue = Object.keys(packageJson.dependencies ?? {})
    .map((name) => packageLockPathForName(name, packageLock))
  const seen = new Set()
  while (queue.length > 0) {
    const lockPath = queue.shift()
    if (seen.has(lockPath)) continue
    const entry = packageLock.packages?.[lockPath]
    assert.ok(entry, `lock entry must exist for ${lockPath}`)
    if (entry.dev || !supportsTarget(entry, { platform, arch })) continue
    seen.add(lockPath)
    for (const name of Object.keys(entry.dependencies ?? {})) {
      queue.push(packageLockPathForName(name, packageLock, lockPath))
    }
    for (const name of Object.keys(entry.optionalDependencies ?? {})) {
      queue.push(packageLockPathForName(name, packageLock, lockPath))
    }
    for (const [name, range] of Object.entries(entry.peerDependencies ?? {})) {
      if (entry.peerDependenciesMeta?.[name]?.optional !== true && range !== undefined) {
        queue.push(packageLockPathForName(name, packageLock, lockPath))
      }
    }
  }
  return [...seen].sort().map((lockPath) => ({
    name: packageNameFromLockPath(lockPath),
    lock_path: lockPath,
    native: /^node_modules\/(?:better-sqlite3|sqlite-vec(?:-|$))/u.test(lockPath),
  }))
}

function packageLockPathForName(name, packageLock, fromLockPath) {
  if (fromLockPath !== undefined) {
    for (const candidateRoot of packageAncestorLockPaths(fromLockPath)) {
      const nestedCandidate = `${candidateRoot}/node_modules/${name}`
      if (packageLock.packages[nestedCandidate] !== undefined) {
        return nestedCandidate
      }
    }
  }
  return `node_modules/${name}`
}

function packageAncestorLockPaths(lockPath) {
  const ancestors = []
  let current = lockPath
  while (current !== undefined) {
    ancestors.push(current)
    current = parentPackageLockPath(current)
  }
  return ancestors
}

function parentPackageLockPath(lockPath) {
  const nestedMarkerIndex = lockPath.lastIndexOf("/node_modules/")
  return nestedMarkerIndex === -1 ? undefined : lockPath.slice(0, nestedMarkerIndex)
}

function packageNameFromLockPath(lockPath) {
  const match = lockPath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/u)
  assert.notEqual(match, null, `lock path must end in a package node_modules segment: ${lockPath}`)
  return match[1]
}

function supportsTarget(entry, { platform, arch }) {
  return (!Array.isArray(entry.os) || entry.os.includes(platform))
    && (!Array.isArray(entry.cpu) || entry.cpu.includes(arch))
}

function relevantLockFields(entry = {}) {
  return {
    version: entry.version,
    resolved: entry.resolved,
    integrity: entry.integrity,
    dependencies: entry.dependencies ?? {},
    optionalDependencies: entry.optionalDependencies ?? {},
    peerDependencies: entry.peerDependencies ?? {},
    peerDependenciesMeta: entry.peerDependenciesMeta ?? {},
    os: entry.os ?? [],
    cpu: entry.cpu ?? [],
    dev: entry.dev === true,
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function makeFixture({
  allowLocalIpc = true,
  deletePreloadAfterLoad = false,
  embeddingEndpoint,
} = {}) {
  if (embeddingEndpoint !== undefined) {
    assert.match(embeddingEndpoint, /^http:\/\/127\.0\.0\.1:\d+\/api\/embeddings$/u)
  }
  const root = mkdtempSync(path.join(tmpdir(), "desk-entrypoint-"))
  const fixtureMcpRoot = path.join(root, "mcp")
  const deskRoot = path.join(root, "desk")
  const runtimeCacheDir = path.join(root, "runtime-cache")
  const binDir = path.join(root, "bin")
  const networkLog = path.join(root, "network.log")
  const commandLog = path.join(root, "commands.log")
  copyMcpPackage(fixtureMcpRoot)
  mkdirSync(deskRoot, { recursive: true })
  mkdirSync(runtimeCacheDir, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  for (const command of ["npm", "npx", "curl", "wget"]) {
    writeFileSync(
      path.join(binDir, command),
      `#!/usr/bin/env sh\necho "${command} $*" >> "${commandLog}"\nexit 91\n`,
      { encoding: "utf8", mode: 0o755 },
    )
  }
  const preloadPath = path.join(root, "forbid-network.mjs")
  const loaderPath = path.join(root, "forbid-network-loader.mjs")
  const forbiddenNetworkModules = allowLocalIpc
    ? ["http", "https", "tls", "node:http", "node:https", "node:tls"]
    : ["http", "https", "net", "tls", "node:http", "node:https", "node:net", "node:tls"]
  writeFileSync(
    loaderPath,
    [
      `import { appendFileSync } from "node:fs"`,
      `const forbidden = new Set(${JSON.stringify(forbiddenNetworkModules)})`,
      `export async function resolve(specifier, context, nextResolve) {`,
      `  if (forbidden.has(specifier)) {`,
      `    appendFileSync(${JSON.stringify(networkLog)}, "module " + specifier + "\\n")`,
      `    throw new Error("network module forbidden during runtime dependency bootstrap: " + specifier)`,
      `  }`,
      `  return nextResolve(specifier, context)`,
      `}`,
      "",
    ].join("\n"),
    "utf8",
  )
  writeFileSync(
    preloadPath,
    [
      `import { register } from "node:module"`,
      `import { appendFileSync, rmSync } from "node:fs"`,
      `import Module from "node:module"`,
      `import { fileURLToPath } from "node:url"`,
      `register(${JSON.stringify(pathToFileURL(loaderPath).href)})`,
      ...(deletePreloadAfterLoad
        ? [`rmSync(fileURLToPath(import.meta.url), { force: true })`]
        : []),
      `const forbidden = new Set(${JSON.stringify(forbiddenNetworkModules)})`,
      `const originalLoad = Module._load`,
      `Module._load = function(request, parent, isMain) {`,
      `  if (forbidden.has(request)) {`,
      `    appendFileSync(${JSON.stringify(networkLog)}, "require " + request + "\\n")`,
      `    throw new Error("network module forbidden during runtime dependency bootstrap: " + request)`,
      `  }`,
      `  return originalLoad.apply(this, arguments)`,
      `}`,
      ...(embeddingEndpoint ? [`const realFetch = globalThis.fetch`] : []),
      `globalThis.fetch = async (...args) => {`,
      ...(embeddingEndpoint ? [
        `  if (String(args[0]) === ${JSON.stringify(embeddingEndpoint)}) {`,
        `    return realFetch(args[0], { ...args[1], redirect: "error" })`,
        `  }`,
      ] : []),
      `  appendFileSync(${JSON.stringify(networkLog)}, JSON.stringify(args.map(String)) + "\\n")`,
      `  throw new Error("network access forbidden during runtime dependency bootstrap")`,
      `}`,
      "",
    ].join("\n"),
    "utf8",
  )
  return {
    root,
    mcpRoot: fixtureMcpRoot,
    deskRoot,
    runtimeCacheDir,
    binDir,
    networkLog,
    commandLog,
    preloadPath,
    embeddingEndpoint,
  }
}

function copyMcpPackage(targetRoot) {
  mkdirSync(targetRoot, { recursive: true })
  for (const entry of [
    "index.js",
    "package.json",
    "package-lock.json",
    "scripts",
    "src",
    "artifacts",
  ]) {
    cpSync(path.join(mcpRoot, entry), path.join(targetRoot, entry), {
      recursive: true,
      filter: (source) => !source.split(path.sep).includes("node_modules"),
    })
  }
}

function fixtureEnv(fixture) {
  return {
    ...process.env,
    DESK_RUNTIME_CACHE_DIR: fixture.runtimeCacheDir,
    DESK_EMBED_ENDPOINT: fixture.embeddingEndpoint ?? "",
    DESK_OLLAMA_ENDPOINT: "",
    OLLAMA_HOST: "",
    ...(fixture.embeddingEndpoint ? {
      DESK_EMBED_MODEL: "nomic-embed-text",
      OLLAMA_EMBED_MODEL: "",
      DESK_EMBED_TIMEOUT_MS: "15000",
    } : {}),
    HOME: path.join(fixture.root, "home"),
    XDG_CACHE_HOME: path.join(fixture.root, "xdg-cache"),
    NODE_OPTIONS: `--import=${pathToFileURL(fixture.preloadPath).href}`,
    NODE_PATH: "",
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  }
}

async function importEntrypointWithoutNodeModules(fixture) {
  return spawnNode([
    "--input-type=module",
    "--eval",
    [
      `const mod = await import(${JSON.stringify(pathToFileURL(path.join(fixture.mcpRoot, "index.js")).href)});`,
      `console.log(JSON.stringify(mod.parseArgs(["--root", "desk", "--person", "agent"])))`,
    ].join("\n"),
  ], {
    cwd: fixture.mcpRoot,
    env: fixtureEnv(fixture),
    timeoutMs: 5000,
  })
}

async function importRuntimeServerWithoutConnecting(fixture) {
  return spawnNode([
    "--input-type=module",
    "--eval",
    [
      `import path from "node:path";`,
      `import { pathToFileURL } from "node:url";`,
      `const { prepareRuntime } = await import(${JSON.stringify(pathToFileURL(path.join(fixture.mcpRoot, "src", "runtime", "bootstrap.js")).href)});`,
      `const prepared = prepareRuntime({ mcpRoot: ${JSON.stringify(fixture.mcpRoot)}, env: process.env, runtimeCacheDir: ${JSON.stringify(fixture.runtimeCacheDir)} });`,
      `await import(pathToFileURL(path.join(prepared.sourceMirrorPath, "src", "server.js")).href);`,
      `process.stdout.write("server-imported\\n")`,
    ].join("\n"),
  ], {
    cwd: fixture.mcpRoot,
    env: fixtureEnv(fixture),
    timeoutMs: 10000,
  })
}

async function runMcpListToolsSession(fixture, { timeoutMs = 10000 } = {}) {
  const child = spawn(process.execPath, [
    path.join(fixture.mcpRoot, "index.js"),
    "--root",
    fixture.deskRoot,
  ], {
    cwd: fixture.mcpRoot,
    env: fixtureEnv(fixture),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stdoutBuffer = ""
  let stderr = ""
  const responses = []
  let closed

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8")
    stdout += text
    stdoutBuffer += text
    const lines = stdoutBuffer.split(/\r?\n/u)
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        responses.push(JSON.parse(line))
      } catch {
        // Keep raw stdout for assertion context.
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8")
  })
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = { code, signal }
      resolve(closed)
    })
  })

  const waitForResponse = (id) => new Promise((resolve, reject) => {
    const started = Date.now()
    const timer = setInterval(() => {
      const response = responses.find((message) => message.id === id)
      if (response !== undefined) {
        clearInterval(timer)
        resolve(response)
      } else if (closed !== undefined) {
        clearInterval(timer)
        reject(new Error(`process exited before response ${id}: ${JSON.stringify(closed)}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer)
        child.kill("SIGTERM")
        reject(new Error(`timed out waiting for response ${id}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
      }
    }, 25)
  })

  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unit-7a", version: "1.0.0" },
    },
  }) + "\n")
  const initialize = await waitForResponse(1)
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }) + "\n")
  child.stdin.write(JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }) + "\n")
  const tools = await waitForResponse(2)
  child.kill("SIGTERM")
  await closePromise
  return {
    code: 0,
    initialize,
    tools,
    stdout,
    stderr,
  }
}

async function runMcpStatusSession(fixture, {
  timeoutMs = 10000,
  waitForConvergence = false,
  onInitialStatus,
} = {}) {
  const child = spawn(process.execPath, [
    path.join(fixture.mcpRoot, "index.js"),
    "--root",
    fixture.deskRoot,
  ], {
    cwd: fixture.mcpRoot,
    env: fixtureEnv(fixture),
    stdio: ["pipe", "pipe", "pipe"],
  })
  let stdout = ""
  let stdoutBuffer = ""
  let stderr = ""
  const responses = []
  const observedReadiness = []
  let closed
  let childError

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8")
    stdout += text
    stdoutBuffer += text
    const lines = stdoutBuffer.split(/\r?\n/u)
    stdoutBuffer = lines.pop() ?? ""
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        responses.push(JSON.parse(line))
      } catch {
        // Keep raw stdout for assertion context.
      }
    }
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8")
  })
  child.once("error", (error) => { childError = error })
  child.stdin.on("error", (error) => { childError = error })
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, signal) => {
      closed = { code, signal }
      resolve(closed)
    })
  })

  const sessionError = (message) => new Error(
    `${message}\nobserved readiness states: ${JSON.stringify(observedReadiness)}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
  )
  const waitForResponse = async (id, deadline = performance.now() + timeoutMs) => {
    let timer
    try {
      return await new Promise((resolve, reject) => {
        timer = setInterval(() => {
          const response = responses.find((message) => message.id === id)
          if (response !== undefined) {
            resolve(response)
          } else if (childError !== undefined) {
            reject(sessionError(`process error before response ${id}: ${childError.message}`))
          } else if (closed !== undefined) {
            reject(sessionError(`process exited before response ${id}: ${JSON.stringify(closed)}`))
          } else if (performance.now() >= deadline) {
            reject(sessionError(`timed out waiting for response ${id}`))
          }
        }, 25)
      })
    } finally {
      clearInterval(timer)
    }
  }

  let nextRequestId = 1
  const sendRequest = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }
  const request = (method, params, deadline) => {
    const id = nextRequestId++
    sendRequest({
      jsonrpc: "2.0",
      id,
      method,
      params,
    })
    return waitForResponse(id, deadline)
  }
  const callTool = (name, args = {}, deadline) => request("tools/call", {
    name,
    arguments: args,
  }, deadline)
  const observeStatus = (response) => {
    assert.equal(response.error, undefined, sessionError("desk_status request failed").message)
    assert.equal(response.result.isError, undefined, sessionError("desk_status tool failed").message)
    const body = JSON.parse(response.result.content[0].text)
    observedReadiness.push({
      id: response.id,
      local_db_exists: body.local_db?.exists,
      local_db_state: body.local_db?.state,
      lexical_available: body.lexical_index?.available,
      document_vectors_state: body.document_vectors?.state,
      chunks_total: body.document_vectors?.chunks_total,
      vectors_indexed: body.document_vectors?.vectors_indexed,
      missing_vectors: body.document_vectors?.missing_vectors,
      repairable_missing_vectors: body.document_vectors?.repairable_missing_vectors,
    })
    return body
  }
  const stopChild = async () => {
    if (closed !== undefined) return
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1000)
    try {
      child.kill("SIGTERM")
      await closePromise
    } finally {
      clearTimeout(killTimer)
    }
  }

  try {
    const initialize = await request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "unit-10a", version: "1.0.0" },
    })
    sendRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })
    const tools = await request("tools/list", {})
    const initialStatus = await callTool("desk_status")
    let body = observeStatus(initialStatus)
    await onInitialStatus?.({ initialize, tools, initialStatus })
    let status = initialStatus
    if (waitForConvergence) {
      const deadline = performance.now() + timeoutMs
      while (
        body.local_db?.exists !== true
        || body.local_db.state !== "available"
        || body.lexical_index?.available !== true
        || body.document_vectors?.state !== "available"
        || !(body.document_vectors.chunks_total > 0)
        || !(body.document_vectors.vectors_indexed > 0)
        || body.document_vectors.missing_vectors !== 0
        || body.document_vectors.repairable_missing_vectors !== 0
      ) {
        if (performance.now() >= deadline) {
          throw sessionError("timed out waiting for converged desk_status")
        }
        status = await callTool("desk_status", {}, deadline)
        body = observeStatus(status)
      }
    }
    const doctor = await callTool("desk_doctor")
    const mutation = await callTool("task_create", {
      track: "diagnostic-probe",
      slug: "must-not-write",
      title: "Must not write",
    })
    return {
      code: 0,
      initialize,
      tools,
      initialStatus,
      status,
      doctor,
      mutation,
      stdout,
      stderr,
    }
  } finally {
    await stopChild()
  }
}

async function runEntrypointExpectingFailure(fixture, { timeoutMs = 5000 } = {}) {
  return spawnNode([
    path.join(fixture.mcpRoot, "index.js"),
    "--root",
    fixture.deskRoot,
  ], {
    cwd: fixture.mcpRoot,
    env: fixtureEnv(fixture),
    timeoutMs,
  })
}

function spawnNode(args, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr, timedOut })
    })
    if (input !== undefined) {
      child.stdin.end(input)
    } else {
      child.stdin.end()
    }
  })
}

function listSourceMirrors(runtimeCacheDir) {
  const mirrorRoot = path.join(runtimeCacheDir, "source-mirror")
  if (!existsSync(mirrorRoot)) return []
  return readdirSync(mirrorRoot)
    .map((name) => path.join(mirrorRoot, name))
    .filter((entry) => statSync(entry).isDirectory())
    .sort()
}

function assertNoBootstrapSideEffects(fixture) {
  assert.equal(existsSync(path.join(fixture.mcpRoot, "node_modules")), false)
  assert.equal(existsSync(fixture.commandLog), false, "runtime bootstrap must not shell out to npm/npx/curl/wget")
  assert.equal(existsSync(fixture.networkLog), false, "runtime must not attempt forbidden network access")
}

function assertRuntimeDependenciesRestoredToCache(fixture) {
  for (const entry of [
    "package.json",
    "package-lock.json",
    "runtime-deps.manifest.json",
    "node_modules/@modelcontextprotocol/sdk/package.json",
    "node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js",
    "node_modules/better-sqlite3/package.json",
    "node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    "node_modules/gray-matter/package.json",
    "node_modules/sqlite-vec/package.json",
  ]) {
    assert.equal(
      existsSync(path.join(fixture.runtimeCacheDir, entry)),
      true,
      `runtime dependency pack must restore ${entry} into DESK_RUNTIME_CACHE_DIR`,
    )
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

async function createEmbeddingBarrier() {
  const requests = []
  const unexpected = []
  let firstResponse
  let released = false
  let requestStarted
  const started = new Promise((resolve) => { requestStarted = resolve })
  const respond = (response) => {
    response.writeHead(200, { "content-type": "application/json", connection: "close" })
    response.end(JSON.stringify({ embedding: Array(768).fill(0.125) }))
  }
  const server = createServer((request, response) => {
    let body = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => { body += chunk })
    request.on("end", () => {
      const call = {
        method: request.method,
        path: request.url,
        host: request.headers.host,
        remoteAddress: request.socket.remoteAddress,
      }
      try {
        assert.equal(call.method, "POST")
        assert.equal(call.path, "/api/embeddings")
        assert.equal(call.host, `127.0.0.1:${server.address().port}`)
        assert.equal(call.remoteAddress, "127.0.0.1")
        const payload = JSON.parse(body)
        assert.equal(payload.model, "nomic-embed-text")
        assert.equal(typeof payload.prompt, "string")
        assert.ok(payload.prompt.length > 0)
        call.prompt = payload.prompt
      } catch (error) {
        unexpected.push({ ...call, error: error.message })
        response.writeHead(400, { connection: "close" })
        response.end("unexpected embedding request")
        return
      }
      requests.push(call)
      if (firstResponse === undefined) {
        firstResponse = response
        requestStarted()
      } else {
        respond(response)
      }
    })
  })
  server.on("clientError", (error, socket) => {
    unexpected.push({ error: error.message })
    socket.destroy()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return {
    endpoint: `http://127.0.0.1:${server.address().port}/api/embeddings`,
    requests,
    unexpected,
    get released() { return released },
    get completed() { return firstResponse?.writableFinished === true },
    get pending() {
      return firstResponse !== undefined
        && !firstResponse.destroyed && !firstResponse.writableEnded
    },
    async waitForRequest(timeoutMs = 10000) {
      let timer
      try {
        await Promise.race([
          started,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              `embedding request never reached convergence barrier: ${JSON.stringify(unexpected)}`,
            )), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    },
    release() {
      assert.equal(this.pending, true, "first embedding response must still be pending")
      assert.equal(released, false)
      released = true
      respond(firstResponse)
    },
    async close() {
      let timer
      try {
        await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error("embedding server cleanup timed out")), 1000)
          server.close((error) => error ? reject(error) : resolve())
          server.closeAllConnections()
        })
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

test("MCP entrypoint is dependency-light before bootstrap", async () => {
  const entrypoint = readFileSync(path.join(mcpRoot, "index.js"), "utf8")
  assert.doesNotMatch(entrypoint, /from\s+["']\.\/src\/server\.js["']/u)
  for (const modulePath of [
    "./src/runtime/diagnostic-server.js",
    "./src/runtime/diagnostics.js",
    "./src/runtime/node-selection.js",
  ]) {
    assert.match(entrypoint, new RegExp(escapeRegExp(modulePath), "u"))
  }
  for (const launchFunction of [
    "selectCompatibleNode",
    "reexecuteWithCompatibleNode",
    "startDiagnosticServer",
  ]) {
    assert.match(entrypoint, new RegExp(`\\b${launchFunction}\\b`, "u"))
  }
  for (const dependency of productionDependencyNames) {
    assert.doesNotMatch(entrypoint, new RegExp(`["']${dependency.replace("/", "\\/")}(?:\\/|["'])`, "u"))
  }

  const fixture = makeFixture()
  try {
    const result = await importEntrypointWithoutNodeModules(fixture)
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.deepEqual(JSON.parse(result.stdout), { root: "desk", person: "agent" })
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("dependency-isolated runtime children cannot resolve host modules through NODE_PATH", async () => {
  const fixture = makeFixture()
  const previousNodePath = process.env.NODE_PATH
  try {
    process.env.NODE_PATH = path.join(mcpRoot, "node_modules")
    const result = await spawnNode([
      "--input-type=commonjs",
      "--eval",
      [
        `try {`,
        `  require.resolve("gray-matter")`,
        `  process.exit(23)`,
        `} catch (error) {`,
        `  if (error.code !== "MODULE_NOT_FOUND") throw error`,
        `}`,
        `process.stdout.write("host-module-unavailable\\n")`,
      ].join("\n"),
    ], {
      cwd: fixture.mcpRoot,
      env: fixtureEnv(fixture),
      timeoutMs: 5000,
    })
    assert.equal(result.timedOut, false, result.stderr)
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(result.stdout, "host-module-unavailable\n")
    assert.equal(process.env.NODE_PATH, path.join(mcpRoot, "node_modules"))
  } finally {
    if (previousNodePath === undefined) delete process.env.NODE_PATH
    else process.env.NODE_PATH = previousNodePath
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("restored runtime server import stays dependency-light until connectOrStartController", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${hostTarget}`,
}, async () => {
  const fixture = makeFixture({ allowLocalIpc: false, deletePreloadAfterLoad: true })
  try {
    const result = await importRuntimeServerWithoutConnecting(fixture)
    assert.equal(result.timedOut, false, result.stderr)
    assert.equal(result.code, 0, result.stderr || result.stdout)
    assert.equal(result.stdout, "server-imported\n")
    assert.equal(existsSync(fixture.commandLog), false, "server import must not shell out to npm/npx/curl/wget")
    assert.equal(existsSync(fixture.networkLog), false, "server import must not touch forbidden network modules before connect")
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("MCP entrypoint restores runtime dependencies offline and serves list-tools from the source mirror", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${hostTarget}`,
}, async () => {
  const fixture = makeFixture()
  try {
    const beforeSource = readFileSync(path.join(fixture.mcpRoot, "src", "tool-names.js"), "utf8")
    const first = await runMcpListToolsSession(fixture)
    assert.equal(first.initialize.error, undefined, first.stderr || first.stdout)
    assert.equal(first.tools.error, undefined, first.stderr || first.stdout)
    assert.ok(
      first.tools.result.tools.some((tool) => tool.name === "desk_search"),
      "list-tools response must come from the restored runtime server",
    )
    assertNoBootstrapSideEffects(fixture)
    assertRuntimeDependenciesRestoredToCache(fixture)
    const firstMirrors = listSourceMirrors(fixture.runtimeCacheDir)
    assert.equal(firstMirrors.length, 1, "runtime cache must contain one source mirror after first start")

    writeFileSync(
      path.join(fixture.mcpRoot, "src", "tool-names.js"),
      beforeSource.replace(
        "Hybrid lexical+semantic search across desk.",
        "Unit 7a source mirror sentinel.",
      ),
      "utf8",
    )
    const second = await runMcpListToolsSession(fixture)
    assert.equal(second.tools.error, undefined, second.stderr || second.stdout)
    assertNoBootstrapSideEffects(fixture)
    const secondMirrors = listSourceMirrors(fixture.runtimeCacheDir)
    assert.equal(secondMirrors.length, 2, "source hash changes must create a new source mirror")
    assert.ok(
      secondMirrors.some((mirror) => (
        readFileSync(path.join(mirror, "src", "tool-names.js"), "utf8").includes("Unit 7a source mirror sentinel.")
      )),
      "new source mirror must contain updated plugin source",
    )
    assert.ok(
      second.tools.result.tools.some((tool) => (
        tool.name === "desk_search" && tool.description.includes("Unit 7a source mirror sentinel.")
      )),
      "list-tools response must be served from the updated source mirror",
    )
    assert.equal(existsSync(path.join(fixture.mcpRoot, "node_modules")), false)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test("MCP entrypoint serves coherent desk_status from the source mirror after background convergence", {
  skip: hostRuntimePackExists ? false : `no committed runtime dependency pack for ${hostTarget}`,
}, async () => {
  const embedding = await createEmbeddingBarrier()
  let fixture
  try {
    fixture = makeFixture({ embeddingEndpoint: embedding.endpoint })
    mkdirSync(path.join(fixture.deskRoot, "ops", "status-check"), { recursive: true })
    writeFileSync(
      path.join(fixture.deskRoot, "ops", "status-check", "task.md"),
      "---\nschema_version: 1\nstatus: in_progress\n---\n\n# Status Check\n\nBackground convergence indexes this file.\n",
      "utf8",
    )

    const result = await runMcpStatusSession(fixture, {
      waitForConvergence: true,
      onInitialStatus: async ({ initialize, tools, initialStatus }) => {
        await embedding.waitForRequest()
        assert.equal(embedding.pending, true, "initial status must arrive while convergence is blocked")
        assert.equal(embedding.released, false)
        assert.equal(embedding.completed, false)
        assert.equal(embedding.requests.length, 1)
        assert.match(embedding.requests[0].prompt, /Status Check/u)
        assert.equal(initialize.error, undefined)
        assert.equal(initialize.result.serverInfo.name, "desk-mcp")
        assert.equal(tools.error, undefined)
        assert.ok(tools.result.tools.some((tool) => tool.name === "desk_status"))
        assert.ok(tools.result.tools.some((tool) => tool.name === "task_create"))
        assert.equal(initialStatus.error, undefined)
        assert.equal(initialStatus.result.isError, undefined)
        const initialBody = JSON.parse(initialStatus.result.content[0].text)
        assert.equal(initialBody.status, "ok")
        assert.equal(initialBody.runtime.loaded_from_source_mirror, true)
        embedding.release()
      },
    })
    assert.equal(result.status.error, undefined, result.stderr || result.stdout)
    assert.equal(result.doctor.error, undefined, result.stderr || result.stdout)
    assert.ok(result.status.id > result.initialStatus.id, "converged status must be a later response")
    assert.equal(result.status.result.isError, undefined, JSON.stringify(result.status.result))
    const body = JSON.parse(result.status.result.content[0].text)
    assert.equal(body.status, "ok")
    assert.equal(body.root.path, fixture.deskRoot)
    assert.equal(body.local_db.exists, true)
    assert.equal(body.local_db.state, "available")
    assert.equal(body.lexical_index.available, true)
    assert.equal(body.startup_fallback.mode, "not_checked")
    assert.equal(body.document_vectors.state, "available")
    assert.ok(body.document_vectors.chunks_total > 0)
    assert.ok(body.document_vectors.vectors_indexed > 0)
    assert.equal(body.document_vectors.missing_vectors, 0)
    assert.equal(body.document_vectors.repairable_missing_vectors, 0)
    assert.equal(body.startup_fallback.degraded, false)
    assert.equal(body.runtime.loaded_from_source_mirror, true)
    assert.ok(
      body.runtime.source_mirror_path.startsWith(path.join(fixture.runtimeCacheDir, "source-mirror")),
      `expected source mirror under runtime cache, got ${body.runtime.source_mirror_path}`,
    )
    assert.equal(
      existsSync(path.join(fixture.deskRoot, ".state", "desk-index.sqlite")),
      true,
      "background convergence should create the lexical local index DB",
    )
    assert.equal(result.doctor.result.isError, undefined, JSON.stringify(result.doctor.result))
    const doctor = JSON.parse(result.doctor.result.content[0].text)
    assert.equal(doctor.status, "ok")
    assert.equal(doctor.mode, "healthy")
    assert.equal(doctor.runtime.state, "ready")
    assert.deepEqual(doctor.remediation, [])
    assert.equal(result.mutation.result.isError, undefined, JSON.stringify(result.mutation.result))
    assert.deepEqual(
      JSON.parse(result.mutation.result.content[0].text),
      {
        status: "created",
        path: path.join("diagnostic-probe", "must-not-write", "task.md"),
      },
      "healthy runtime mode must execute valid mutations rather than returning diagnostic errors",
    )
    assert.equal(
      existsSync(path.join(fixture.deskRoot, "diagnostic-probe", "must-not-write", "task.md")),
      true,
    )
    assert.equal(embedding.released, true)
    assert.equal(embedding.completed, true)
    assert.ok(embedding.requests.length > 0)
    assert.deepEqual(embedding.unexpected, [])
    assertNoBootstrapSideEffects(fixture)
  } finally {
    try {
      await embedding.close()
    } finally {
      if (fixture) rmSync(fixture.root, { recursive: true, force: true })
    }
  }
})

test("MCP entrypoint keeps a diagnostic MCP live when the current runtime pack is missing", async () => {
  const fixture = makeFixture()
  try {
    const artifactsRoot = path.join(fixture.mcpRoot, "artifacts", "runtime-deps", packageJson.version)
    const actualTargetDir = path.join(artifactsRoot, hostTarget)
    const wrongTargetDir = path.join(artifactsRoot, `${process.platform}-${process.arch}-node-0`)
    let seedTargetDir
    if (existsSync(actualTargetDir)) {
      seedTargetDir = path.join(artifactsRoot, `${hostTarget}.saved-for-test`)
      renameSync(actualTargetDir, seedTargetDir)
    } else {
      seedTargetDir = readdirSync(artifactsRoot)
        .map((name) => path.join(artifactsRoot, name))
        .find((candidate) => statSync(candidate).isDirectory())
    }
    assert.ok(seedTargetDir, "runtime fixture must contain at least one committed target to synthesize ABI mismatch")
    rmSync(wrongTargetDir, { recursive: true, force: true })
    cpSync(seedTargetDir, wrongTargetDir, { recursive: true })
    if (path.basename(seedTargetDir).endsWith(".saved-for-test")) {
      rmSync(seedTargetDir, { recursive: true, force: true })
    }

    const result = await runMcpStatusSession(fixture)
    assert.equal(result.initialize.error, undefined, result.stderr || result.stdout)
    assert.equal(result.initialize.result.serverInfo.name, "desk-mcp-diagnostic")
    assert.equal(result.initialize.result.serverInfo.version, packageJson.version)
    assert.deepEqual(
      result.tools.result.tools.map((tool) => tool.name),
      ["desk_status", "desk_doctor"],
    )
    assert.equal(result.status.result.isError, undefined)
    const status = JSON.parse(result.status.result.content[0].text)
    assert.equal(status.status, "degraded")
    assert.equal(status.mode, "diagnostic")
    assert.equal(status.runtime.current_target.id, hostTarget)
    assert.ok(["missing_pack", "unsupported_target", "no_compatible_node"].includes(status.reason))
    assert.equal(
      status.remediation.some((item) => item.action === "refresh_plugin"),
      true,
    )
    assert.match(
      JSON.stringify(status.runtime.paths_checked),
      new RegExp(escapeRegExp(path.join(artifactsRoot, hostTarget)), "u"),
    )
    assert.equal(result.doctor.result.isError, undefined)
    const doctor = JSON.parse(result.doctor.result.content[0].text)
    assert.equal(doctor.mode, "diagnostic")
    assert.deepEqual(doctor.runtime, status.runtime)
    assert.deepEqual(doctor.remediation, status.remediation)
    assert.equal(result.mutation.result.isError, true)
    assert.match(result.mutation.result.content[0].text, new RegExp(escapeRegExp(hostTarget), "u"))
    assert.match(result.mutation.result.content[0].text, /"action":\s*"refresh_plugin"/u)
    assert.doesNotMatch(result.stderr, /Cannot find package '@modelcontextprotocol\/sdk'/u)
    assert.doesNotMatch(result.stderr, /\n\s+at\s+/u)
    assertNoBootstrapSideEffects(fixture)
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
