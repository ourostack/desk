param(
  [Parameter(Mandatory=$true)][string]$PublicMcpRoot,
  [Parameter(Mandatory=$true)][string]$SourceRevision
)
$ErrorActionPreference = 'Stop'
if ($SourceRevision -cnotmatch '^[0-9a-f]{40}$') { throw 'owned_git_source_revision' }
$root = (Resolve-Path -LiteralPath $PublicMcpRoot).ProviderPath
if (![IO.Path]::IsPathRooted($PublicMcpRoot) -or $root -cne [IO.Path]::GetFullPath($PublicMcpRoot)) {
  throw 'owned_git_public_root'
}
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'STOP missing installed vswhere' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation -or $LASTEXITCODE -ne 0) { throw 'STOP missing installed VC toolchain' }
$devcmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$compiler = Join-Path $installation 'VC\Tools\Llvm\x64\bin\clang-cl.exe'
if (!(Test-Path -LiteralPath $compiler -PathType Leaf)) { throw 'STOP missing installed clang-cl' }
$target = Join-Path $root 'artifacts\owned-git\win32-x64'
[IO.Directory]::CreateDirectory($target) | Out-Null
$source = Join-Path $root 'native\windows-owned-git.c'
$owner = Join-Path $target 'desk-owned-git.exe'
$obj = Join-Path $target 'desk-owned-git.obj'
$flags = @('/W4', '/WX', '/MT', '/O2', '/fp:precise', 'kernel32.lib', 'advapi32.lib')
$command = 'call "' + $devcmd + '" -arch=x64 -host_arch=x64 >nul && "' + $compiler +
  '" --version && set WindowsSDKVersion && "' + $compiler +
  '" /W4 /WX /MT /O2 /fp:precise "' + $source + '" /Fe:"' + $owner + '" /Fo:"' + $obj +
  '" /link kernel32.lib advapi32.lib'
$output = @(& $env:ComSpec /d /s /c $command 2>&1)
if ($LASTEXITCODE -ne 0) { throw 'STOP owned_git_compile_failed' }
$version = ($output | Where-Object { "$_" -match 'clang version ' } | Select-Object -First 1).ToString().Trim()
$sdkLine = $output | Where-Object { "$_" -match '^WindowsSDKVersion=' } | Select-Object -First 1
if (!$version -or !$sdkLine) { throw 'STOP owned_git_toolchain_identity' }
$sdkVersion = "$sdkLine".Substring(18).Trim().TrimEnd('\')
$utf8 = [Text.UTF8Encoding]::new($false)
foreach ($value in @($version, $sdkVersion)) {
  if (!$value -or $utf8.GetByteCount($value) -gt 1024 -or $value.Contains([char]0)) { throw 'owned_git_toolchain_identity' }
}
$shim = Join-Path $target 'owned-git-child.cjs'
[IO.File]::Copy((Join-Path $root 'scripts\owned-git-child.cjs'), $shim, $true)
function Hash([string]$File) { return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
$sources = @('native/windows-owned-git.c', 'scripts/owned-git-child.cjs', 'scripts/build-owned-git.ps1', 'scripts/verify-owned-git.js') |
  ForEach-Object { [ordered]@{ path = $_; sha256 = (Hash (Join-Path $root $_)) } }
$manifest = [ordered]@{
  schema = 'desk.owned-git-assets/1'; protocol = 'desk.owned-git/1'; target = 'win32-x64'; variant = 'production'
  sourceRevision = $SourceRevision; sources = @($sources)
  toolchain = [ordered]@{ compiler = 'clang-cl'; version = $version; sdkVersion = $sdkVersion; flags = $flags }
  files = [ordered]@{
    owner = [ordered]@{ path = 'desk-owned-git.exe'; sha256 = (Hash $owner) }
    shim = [ordered]@{ path = 'owned-git-child.cjs'; sha256 = (Hash $shim) }
  }
}
[IO.File]::WriteAllText((Join-Path $target 'manifest.json'), ($manifest | ConvertTo-Json -Depth 8 -Compress), $utf8)
# Source-only stage: do not invoke this builder until separate native admission.
# Runtime verification reads back these exact assets through verifyOwnedGitAssets.
