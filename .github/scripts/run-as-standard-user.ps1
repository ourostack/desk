# Runs one command as a freshly created, non-administrator local user and exits with its exit code.
# Usage: run-as-standard-user.ps1 -WorkDir <dir> -Command '<cmd.exe command line>'
# GitHub's Windows runners run as an administrator, so this is how the Desk suite is run as a user without elevation.
param(
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$LogDir = (Join-Path $env:RUNNER_TEMP 'standard-user-logs')
)
$ErrorActionPreference = 'Stop'
$userName = 'deskstd'
# Throwaway account on an ephemeral runner; the password never leaves this job.
$plain = 'Ds!' + [guid]::NewGuid().ToString('N')
$secure = ConvertTo-SecureString $plain -AsPlainText -Force
if (-not (Get-LocalUser -Name $userName -ErrorAction SilentlyContinue)) {
  New-LocalUser -Name $userName -Password $secure -PasswordNeverExpires -AccountNeverExpires | Out-Null
} else {
  Set-LocalUser -Name $userName -Password $secure
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
# A person owns their own checkout. Without this Git refuses the repository as 'dubious ownership' for the new user.
icacls $workspace /setowner $userName /T /C /Q | Out-Null
git config --system --add safe.directory '*'

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
$p = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/d', '/c', "`"$wrapper`"" `
  -Credential $cred -WorkingDirectory $WorkDir -LoadUserProfile -PassThru -Wait `
  -RedirectStandardOutput $out -RedirectStandardError $err
Get-Content $out
Get-Content $err | ForEach-Object { Write-Host "[stderr] $_" }
exit $p.ExitCode
