# Product mode requires fresh creation; legacy mode retains create-or-reuse.
# Usage: run-as-standard-user.ps1 -WorkDir <dir> -Command '<cmd.exe command line>'
# GitHub's Windows runners run as an administrator, so this is how the Desk suite is run as a user without elevation.
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$LogDir = (Join-Path $env:RUNNER_TEMP 'standard-user-logs'),
  [switch]$OwnedGitProduct
)
$ErrorActionPreference = 'Stop'
$userName = 'deskstd'
# Throwaway account on an ephemeral runner; the password never leaves this job.
$plain = 'Ds!' + [guid]::NewGuid().ToString('N')
Write-Host "::add-mask::$plain"
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
$ownedSid = $null
$ownedCleanupFailed = $false
try {
if ($OwnedGitProduct) {
  $created = @(Microsoft.PowerShell.LocalAccounts\New-LocalUser -Name $userName -Password $secure `
    -PasswordNeverExpires -AccountNeverExpires -ErrorAction Stop -Confirm:$false)
  if ($created.Count -ne 1 -or $created[0] -isnot [Microsoft.PowerShell.Commands.LocalUser] -or
      ![string]::Equals($created[0].Name, $userName, [StringComparison]::OrdinalIgnoreCase) -or
      $created[0].SID -isnot [Security.Principal.SecurityIdentifier]) {
    throw 'owned_git_product_account_creation_unproved'
  }
  $ownedSid = $created[0].SID
} else {
if (-not (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $userName -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
} else {
  Set-LocalUser -Name $userName -Password $secure
}
}
if (Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "*\$userName" }) {
  throw "$userName must not be an administrator"
}
$workspace = (Resolve-Path $WorkDir).Path
$tmp = 'C:\deskstd-tmp'
New-Item -ItemType Directory -Force -Path $tmp, $LogDir | Out-Null
foreach ($dir in @($workspace, $tmp, $LogDir)) {
  icacls $dir /grant "${userName}:(OI)(CI)M" /T /C /Q | Out-Null
}
# Existing ephemeral-runner ownership provisioning remains shared. Only legacy
# mode mutates machine-wide Git trust; product metadata uses exact command scope.
icacls $workspace /setowner $userName /T /C /Q | Out-Null
if (-not $OwnedGitProduct) { git config --system --add safe.directory '*' }

$nodeDir = Split-Path (Get-Command node).Source
$gitDir = Split-Path (Get-Command git).Source
# The same machine-wide PATH a person gets (PowerShell 7, Git, Python and so on), plus the runner's Node and Git.
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$wrapper = Join-Path $LogDir 'run.cmd'
@"
@echo off
set "PATH=$nodeDir;$gitDir;$machinePath"
set "TEMP=$tmp"
set "TMP=$tmp"
set "CI=true"
set "DESK_TEST_SUITE_MODE=standard"
cd /d "$WorkDir"
echo whoami: & whoami
echo token elevation and integrity level: & whoami /groups | findstr /i "Mandatory Administrators"
$Command
exit /b %ERRORLEVEL%
"@ | Set-Content -Encoding ASCII $wrapper
icacls $wrapper /grant "${userName}:(R)" /Q | Out-Null

$cred = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$userName", $secure)
$out = Join-Path $LogDir 'stdout.log'
$err = Join-Path $LogDir 'stderr.log'
$exitCode = 1
try {
if ($OwnedGitProduct) {
  $productRootExited = $false
  $p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d', '/c', "`"$wrapper`"" `
    -Credential $cred -WorkingDirectory $WorkDir -LoadUserProfile -PassThru `
    -RedirectStandardOutput $out -RedirectStandardError $err
  try {
    $p.WaitForExit()
    $productRootExited = $true
    $exitCode = $p.ExitCode
  } finally {
    if ($productRootExited) {
      try { $p.Dispose() } catch {
        $ownedCleanupFailed = $true
        try { [Console]::Error.WriteLine('owned_git_product_process_cleanup_failed') } catch { }
      }
    }
  }
} else {
$p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d', '/c', "`"$wrapper`"" `
  -Credential $cred -WorkingDirectory $WorkDir -LoadUserProfile -PassThru -Wait `
  -RedirectStandardOutput $out -RedirectStandardError $err
if (-not $OwnedGitProduct) {
  Get-Content $out
  Get-Content $err | ForEach-Object { Write-Host "[stderr] $_" }
}
$exitCode = $p.ExitCode
}
} finally {
  if (-not $OwnedGitProduct) { Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue }
}
} finally {
  if ($OwnedGitProduct -and $null -ne $ownedSid) {
    try {
      Microsoft.PowerShell.LocalAccounts\Remove-LocalUser -SID $ownedSid -ErrorAction Stop -Confirm:$false
    } catch {
      $ownedCleanupFailed = $true
      try { [Console]::Error.WriteLine('owned_git_product_account_cleanup_failed') } catch { }
    }
  }
}
if ($OwnedGitProduct -and $ownedCleanupFailed -and $exitCode -eq 0) { $exitCode = 1 }
exit $exitCode
