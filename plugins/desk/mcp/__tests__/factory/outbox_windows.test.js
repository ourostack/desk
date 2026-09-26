// Native proof that the factory outbox's Windows owner-only protection is
// real: it uses the same `protectWindowsPaths` routine as the private
// feedback and work-ledger stores (`src/protected/store.js`), applied to
// the factory state root, the machine secret and an outbox file, with no
// injected runner — the real NTFS DACL, read back with the same
// `nativeProbe` helper `windows_acl.test.js` uses. Skipped everywhere but a
// real Windows host; nothing on another platform substitutes for it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { readMachineSecret, setConsent, writeMarker } from "../../src/factory/outbox.js"
import { nativeProbe } from "../feedback/_helpers.js"

const isWindows = process.platform === "win32"

async function mkFactoryEnv() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "desk-outbox-win-"))
  // Real `process.env` underneath (this test uses no injected runner, so it
  // needs the real %SystemRoot% to find the real PowerShell provider), with
  // only the state location redirected into the temp folder.
  return { base, env: { ...process.env, HOME: base, XDG_STATE_HOME: path.join(base, "state") } }
}

function readAcl(target) {
  return nativeProbe(
    "$a=Get-Acl -LiteralPath $request.path;" +
      "$r=@($a.GetAccessRules($true,$false,[System.Security.Principal.SecurityIdentifier]));" +
      "ConvertTo-Json -Compress -InputObject ([pscustomobject]@{" +
      "owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;" +
      "protected=$a.AreAccessRulesProtected;count=$r.Count;" +
      "identity=$r[0].IdentityReference.Value;rights=$r[0].FileSystemRights.ToString()})",
    { path: target },
  )
}

test("native: the factory state root, the machine secret and an outbox file each carry an owner-only, single-rule NTFS DACL for the current user", {
  skip: isWindows ? false : "requires a native Windows host",
}, async () => {
  const { base, env } = await mkFactoryEnv()
  try {
    const consent = await setConsent(env, { store: "ourostack/factory", contribute: true })
    assert.equal(consent.stores["ourostack/factory"].contribute, true)
    const secret = await readMachineSecret(env)
    assert.equal(secret.length, 32)
    const marker = {
      schema_version: 1,
      host: "claude-code",
      session_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
      log_path: "C:\\session.log",
      cwd: "C:\\project",
      desk_root: "C:\\desk",
      end_reason: "prompt_input_exit",
      ended_at: "2026-09-25T09:30:00.000Z",
      plugins: [{ name: "desk", version: "3.2.0-alpha.37" }],
      updated_at: "2026-09-25T09:30:00.000Z",
    }
    await writeMarker(env, marker)

    const root = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory")
    const secretFile = path.join(root, "machine-secret")
    const markerFile = path.join(root, "markers", `${marker.host}-${marker.session_id}.json`)
    const self = readAcl(root).owner

    for (const target of [root, secretFile, markerFile]) {
      const acl = readAcl(target)
      assert.equal(acl.owner, self, `${target} must be owned by the current user`)
      assert.equal(acl.protected, true, `${target} must not inherit rules`)
      assert.equal(acl.count, 1, `${target} must carry exactly one access rule`)
      assert.equal(acl.identity, self)
      assert.match(acl.rights, /FullControl/u)
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true })
  }
})
