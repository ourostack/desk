# Product mode requires fresh creation; legacy mode retains create-or-reuse.
# Usage: run-as-standard-user.ps1 -WorkDir <dir> -Command '<cmd.exe command line>'
# GitHub's Windows runners run as an administrator, so this is how the Desk suite is run as a user without elevation.
[CmdletBinding(DefaultParameterSetName = 'Legacy')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Legacy')][string]$WorkDir,
  [Parameter(Mandatory = $true, ParameterSetName = 'Legacy')][string]$Command,
  [Parameter(ParameterSetName = 'Legacy')][string]$LogDir,
  [Parameter(ParameterSetName = 'Legacy')][switch]$OwnedGitProduct,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][switch]$F0Inventory,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][string]$F0RepositoryRoot,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][string]$F0SourceRevision,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][string]$F0NodePath,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][string]$F0IntentSha256,
  [Parameter(Mandatory = $true, ParameterSetName = 'F0')][ValidateRange(1,300000)][int]$F0RemainingMs
)
$ErrorActionPreference = 'Stop'
if ([string]::Equals($PSCmdlet.ParameterSetName, 'F0', [StringComparison]::Ordinal)) {
  try {
    if (!$F0Inventory.IsPresent -or
        ![string]::Equals($PSVersionTable.PSEdition, 'Core', [StringComparison]::Ordinal) -or
        $PSVersionTable.PSVersion.Major -lt 7 -or ![Environment]::Is64BitProcess -or
        !($F0SourceRevision -cmatch '\A[0-9a-f]{40}\z') -or !($F0IntentSha256 -cmatch '\A[0-9a-f]{64}\z')) {
      throw 'foundation'
    }
    foreach ($value in @($F0RepositoryRoot, $F0NodePath)) {
      if (![IO.Path]::IsPathFullyQualified($value) -or [Text.Encoding]::UTF8.GetByteCount($value) -gt 1024 -or
          $value.IndexOfAny([char[]]@([char]0,[char]13,[char]10,[char]34)) -ge 0) { throw 'foundation' }
    }
    $repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    if (![string]::Equals($repository, $F0RepositoryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'foundation' }
    $builder = Join-Path $F0RepositoryRoot 'tests\desk\mcp\__tests__\runtime\fixtures\build_windows_owned_git_fixtures.ps1'
    & $builder -WorkerMode f0-host -F0RepositoryRoot $F0RepositoryRoot -F0SourceRevision $F0SourceRevision `
      -F0NodePath $F0NodePath -F0IntentSha256 $F0IntentSha256 -F0RemainingMs $F0RemainingMs
    if ($LASTEXITCODE -isnot [int] -or $LASTEXITCODE -ne 0) { exit 1 }
    exit 0
  } catch {
    [Console]::Error.WriteLine('foundation')
    exit 1
  }
}
if ($OwnedGitProduct) { [Console]::Error.WriteLine('not-admitted'); exit 1 }
if (!$PSBoundParameters.ContainsKey('LogDir')) { $LogDir = Join-Path $env:RUNNER_TEMP 'standard-user-logs' }
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
