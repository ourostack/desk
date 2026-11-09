import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pendingMigrations } from "../../../../../plugins/desk/mcp/src/runtime/pending-migrations.js"
import { removeTree } from "../_remove_tree.js"

function fixture(t, detect) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-migration-inspection-"))
  t.after(() => removeTree(root))
  const migrations = path.join(root, "migrations")
  mkdirSync(migrations)
  const quote = (file) => `'${file.replace(/'/gu, "'\\''")}'`
  const safety = path.join(root, "safety-effect")
  const applied = path.join(root, "migration-effect")
  writeFileSync(path.join(migrations, "01-safe.md"), `---\nid: 01-safe\nsafety: safe\nneeds_restart: false\n---\n\n## Detect\n\n\`\`\`bash\n${detect}\n\`\`\`\n\n## Safety check\n\n\`\`\`bash\nprintf safety > ${quote(safety)}\n\`\`\`\n\n## Migrate\n\n\`\`\`bash\nprintf applied > ${quote(applied)}\n\`\`\`\n\n## Announce\n\nApplied.\n`)
  return { root, safety, applied }
}

test("inspection reports a safe migration pending without racing an owned task write", async (t) => {
  const f = fixture(t, "sleep 0.2; exit 0")
  const task = path.join(f.root, "task")
  writeFileSync(task, "before")
  const inspecting = pendingMigrations({ pluginRoot: f.root, cwd: f.root, inspectOnly: true, budgetMs: 10000 })
  writeFileSync(task, "the running task owns these bytes")
  const result = await inspecting
  assert.equal(result[0].state, "pending")
  assert.equal(result[0].reason, "writer_custody_required")
  assert.equal(existsSync(f.safety), false)
  assert.equal(existsSync(f.applied), false)
  assert.equal(readFileSync(task, "utf8"), "the running task owns these bytes")
  const normal = await pendingMigrations({ pluginRoot: f.root, cwd: f.root, budgetMs: 10000 })
  assert.equal(normal[0].state, "ran")
  assert.equal(readFileSync(f.safety, "utf8"), "safety")
  assert.equal(readFileSync(f.applied, "utf8"), "applied")
})

test("incomplete inspection stays unchecked rather than becoming a detected pending migration", async (t) => {
  const f = fixture(t, "exec sleep 1")
  const result = await pendingMigrations({ pluginRoot: f.root, cwd: f.root, inspectOnly: true, budgetMs: 20 })
  assert.equal(result[0].state, "unchecked")
  assert.equal(existsSync(f.applied), false)
  assert.equal(existsSync(f.safety), false)
})
