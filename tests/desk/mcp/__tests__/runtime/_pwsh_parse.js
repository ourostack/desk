// PowerShell's own parser, for the differential check of the guard's hand-written tokenizer: `parseCommands` asks
// `[System.Management.Automation.Language.Parser]::ParseInput` for every CommandAst (and every member call) of each text.
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const SCRIPT = `param([string]$Path)
$texts = Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json
$results = foreach ($text in $texts) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($text, [ref]$tokens, [ref]$errors)
  $commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    [pscustomobject]@{ name = $_.GetCommandName(); operator = $_.InvocationOperator.ToString(); text = $_.Extent.Text }
  })
  $members = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { $_.Member.Extent.Text })
  [pscustomobject]@{ errors = $errors.Count; commands = $commands; members = $members }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
`

/** Whether a PowerShell 7 (or Windows PowerShell) is installed here. */
export function pwshPath() {
  for (const candidate of ["pwsh", "powershell"]) {
    const probe = spawnSync(candidate, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" })
    if (probe.status === 0) return candidate
  }
  return null
}

/** `[{ errors, commands: [{ name, operator, text }], members: [string] }]`, one per text, from PowerShell's parser. */
export function parseCommands(shell, texts) {
  const dir = mkdtempSync(path.join(tmpdir(), "desk-pwsh-parse-"))
  try {
    writeFileSync(path.join(dir, "texts.json"), JSON.stringify(texts), "utf8")
    writeFileSync(path.join(dir, "parse.ps1"), SCRIPT, "utf8")
    const run = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "parse.ps1"), "-Path", path.join(dir, "texts.json")], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    if (run.status !== 0) throw new Error(`${shell} could not parse: ${run.stderr}`)
    return JSON.parse(run.stdout)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
