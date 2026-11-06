import http from "node:http"
import { spawn, spawnSync } from "node:child_process"
import path from "node:path"

const root = process.argv[2]
const mode = process.argv[3]
let dropReceive = mode === "drop-after-receive"
const children = new Set()
const server = http.createServer((request, response) => {
  const url = new URL(request.url, "http://127.0.0.1")
  const match = /^\/(origin|alternate)\.git\/(?:info\/refs|git-(?:upload|receive)-pack)$/u.exec(url.pathname)
  if (!match) { response.writeHead(404).end(); return }
  const user = match[1] === "origin" ? "fixture-a" : "fixture-b"
  const wanted = `Basic ${Buffer.from(`${user}:test-only`).toString("base64")}`
  const accepted = request.headers.authorization === wanted
  process.send({ type: "request", destination: match[1], authenticated: accepted })
  if (!accepted) { response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end(); return }
  const receive = url.pathname.endsWith("/git-receive-pack")
  if (mode === "deny-receive-auth" && (receive || url.searchParams.get("service") === "git-receive-pack")) {
    process.send({ type: "receive_auth_denied" })
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="fixture"' }).end()
    return
  }
  const tip = () => {
    const result = spawnSync("/usr/bin/git", ["--git-dir", path.join(root, `${match[1]}.git`), "rev-parse", "refs/heads/main"], { encoding: "utf8", env: process.env })
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const before = receive && dropReceive ? tip() : null
  const child = spawn("/usr/bin/git", ["http-backend"], { env: {
    ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1", REMOTE_USER: user,
    REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: request.headers["content-length"] ?? "",
    ...(request.headers["git-protocol"] ? { GIT_PROTOCOL: request.headers["git-protocol"] } : {}),
  }, stdio: ["pipe", "pipe", "pipe"] })
  children.add(child)
  process.send({ type: "backend", pid: child.pid, root })
  const output = []
  child.stdout.on("data", bytes => output.push(bytes))
  child.stderr.resume()
  child.stdin.on("error", error => { if (error.code !== "EPIPE") response.destroy(error) })
  request.pipe(child.stdin)
  child.on("close", (code, signal) => {
    children.delete(child)
    if (process.connected) process.send({ type: "backend_closed", pid: child.pid, code, signal, root })
    if (response.destroyed) return
    const bytes = Buffer.concat(output), split = bytes.indexOf("\r\n\r\n")
    if (code !== 0 || split < 0) { response.writeHead(500).end(); return }
    const headers = {}
    let status = 200
    for (const line of bytes.subarray(0, split).toString().split("\r\n")) {
      const i = line.indexOf(":")
      if (i < 0) continue
      if (line.slice(0, i).toLowerCase() === "status") status = Number(line.slice(i + 1).trim().split(" ")[0])
      else headers[line.slice(0, i)] = line.slice(i + 1).trim()
    }
    const body = bytes.subarray(split + 4)
    if (receive && dropReceive && status === 200 && body.includes(Buffer.from("ok refs/heads/main\n"))) {
      const after = tip()
      if (before === after) throw new Error("owned receive-pack did not advance its branch before response drop")
      dropReceive = false
      process.send({ type: "accepted_then_dropped", before, after, ref: "refs/heads/main" })
      response.writeHead(status, { ...headers, "Content-Length": body.length })
      response.write(body.subarray(0, 1), () => response.socket.resetAndDestroy())
      return
    }
    response.writeHead(status, headers).end(body)
  })
})
server.listen(0, "127.0.0.1", () => process.send({ type: "ready", endpoint: `http://127.0.0.1:${server.address().port}` }))
process.on("message", message => {
  if (message !== "stop") return
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM")
  server.closeAllConnections()
  server.close(() => process.disconnect())
})
