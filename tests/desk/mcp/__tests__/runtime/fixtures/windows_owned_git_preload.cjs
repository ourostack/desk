"use strict"
const fs = require("node:fs")
const path = require("node:path")
const role = String(process.versions.node.split(".")[0])
const id = process.env.DESK_TEST_OWNED_GIT_CASE
const marker = process.env.DESK_TEST_OWNED_GIT_MARKER
const root = process.env.DESK_TEST_OWNED_GIT_PUBLIC_FIXTURES
if (!["20", "22", "24"].includes(role) || !/^(?:O01|X01|A14|A23|A24)-P(?:20|22|24)-R(?:20|22|24)$/.test(id || "") ||
  !marker || !path.isAbsolute(marker) || !root || !path.isAbsolute(root)) {
  process.exitCode = 1
} else {
  const expectedOptions = `--require "${path.join(root, "windows_owned_git_preload.cjs")}"`
  const value = { case: id, kind: "downstream", runtime: role,
    optionsMatch: process.env.NODE_OPTIONS === expectedOptions, nodePathMatch: process.env.NODE_PATH === root,
    origin: "producer_reported" }
  const fd = fs.openSync(marker, "wx")
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
