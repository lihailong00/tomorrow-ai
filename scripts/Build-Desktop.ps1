[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$TauriConfigPath,
  [ValidateSet('Debug','Release')][string]$BuildType = 'Release',
  [ValidateSet('x86_64-pc-windows-msvc','aarch64-pc-windows-msvc')][string]$RustTarget = 'x86_64-pc-windows-msvc',
  [switch]$NoBundle,
  [switch]$RunRustTests,
  [switch]$Publish,
  [switch]$CleanBuildCache,
  [ValidateRange(100000000,50000000000)][long]$EstimatedBuildBytes = 4000000000
)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$desktopPath = Join-Path $repoPath 'apps/desktop'
$nativePath = Join-Path $desktopPath 'src-tauri'
$targetPath = Join-Path $nativePath 'target'
$outputPath = Join-Path $repoPath 'artifacts/desktop'
$oldPath = $env:Path
$oldTarget = $env:CARGO_TARGET_DIR
$lease = $null
$before = $null
$after = $null
$succeeded = $false
$delivery = $null
$removedBytes = 0L
$cleanup = [Collections.Generic.List[string]]::new()
$failure = $null
. (Join-Path $PSScriptRoot 'Project-Storage.ps1')

function Invoke-Checked([string]$Program, [string[]]$Arguments) {
  & $Program @Arguments
  if ($LASTEXITCODE -ne 0) { throw ('Command failed with exit {0}: {1}' -f $LASTEXITCODE, $Program) }
}

function Commit-DesktopFile([string]$Source, [string]$Destination) {
  # The staging directory is on the destination volume. File.Replace handles an
  # existing Windows file atomically; Move-Item -Force can fail with ERROR_ALREADY_EXISTS.
  if (Test-Path -LiteralPath $Destination -PathType Leaf) {
    # Keep the replaced bytes inside this invocation's staging directory too.
    # PowerShell can coerce $null to an empty backup path for this .NET overload.
    [IO.File]::Replace($Source, $Destination, ($Source + '.replaced'))
  } else {
    [IO.File]::Move($Source, $Destination)
  }
}

function Publish-DesktopBinary([string]$Candidate, [string]$Directory, [string]$Version) {
  Assert-TadaPlainPath $Directory
  $latest = Join-Path $Directory 'tada-desktop-latest.exe'
  $rollback = Join-Path $Directory 'tada-desktop-rollback.exe'
  $metadata = Join-Path $Directory 'latest.json'
  foreach ($path in @($Candidate,$latest,$rollback,$metadata)) { Assert-TadaPlainPath $path }
  $newHash = (Get-FileHash -LiteralPath $Candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  $oldHash = if (Test-Path -LiteralPath $latest) { (Get-FileHash -LiteralPath $latest -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  $stage = Join-Path $Directory ('.desktop-publish-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  $backups = @{}
  $changed = [Collections.Generic.List[string]]::new()
  $committed = $false
  try {
    foreach ($path in @($latest,$rollback,$metadata)) {
      if (Test-Path -LiteralPath $path) {
        $copy = Join-Path $stage ([IO.Path]::GetFileName($path) + '.previous')
        Copy-Item -LiteralPath $path -Destination $copy
        $backups[$path] = $copy
      }
    }
    if ($oldHash -and $oldHash -ne $newHash) {
      Copy-Item -LiteralPath $latest -Destination (Join-Path $stage 'rollback.next')
      Commit-DesktopFile (Join-Path $stage 'rollback.next') $rollback
      $changed.Add($rollback)
      if ((Get-FileHash -LiteralPath $rollback -Algorithm SHA256).Hash.ToLowerInvariant() -ne $oldHash) { throw 'Rollback verification failed.' }
    }
    Copy-Item -LiteralPath $Candidate -Destination (Join-Path $stage 'latest.next')
    Commit-DesktopFile (Join-Path $stage 'latest.next') $latest
    $changed.Add($latest)
    if ((Get-FileHash -LiteralPath $latest -Algorithm SHA256).Hash.ToLowerInvariant() -ne $newHash) { throw 'Latest verification failed.' }
    $record = [ordered]@{
      schema_version=1; version=$Version; platform='windows'; architecture=$(if ($RustTarget -like 'aarch64-*') { 'aarch64' } else { 'x86_64' })
      binary='tada-desktop-latest.exe'; sha256=$newHash; bytes=(Get-Item -LiteralPath $latest).Length
      published_at=[DateTimeOffset]::UtcNow.ToString('o'); rollback_sha256=$(if (Test-Path -LiteralPath $rollback) { (Get-FileHash -LiteralPath $rollback -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null })
      code_signed=$false; source_commit=(& git -C $repoPath rev-parse HEAD)
    }
    [IO.File]::WriteAllText((Join-Path $stage 'metadata.next'), ($record | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
    Commit-DesktopFile (Join-Path $stage 'metadata.next') $metadata
    $changed.Add($metadata)
    $committed = $true
    return [pscustomobject]$record
  } finally {
    if (-not $committed) {
      foreach ($path in $changed) {
        if ($backups.ContainsKey($path)) { Copy-Item -LiteralPath $backups[$path] -Destination $path -Force }
        elseif (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
      }
    }
    # Only this invocation's small, explicitly created staging directory.
    $fullStage = Get-TadaFullPath $stage
    if ((Test-TadaPathInside $fullStage $Directory) -and ([IO.Path]::GetFileName($fullStage) -like '.desktop-publish-*')) {
      Assert-TadaPlainPath $fullStage
      try {
        Remove-Item -LiteralPath $fullStage -Recurse -Force -ErrorAction Stop
      } catch {
        # Windows can keep the replaced image mapped while an older app is
        # running. A committed latest/rollback must not be reported as failed
        # just because that old image cannot yet be removed.
        Write-Warning ('Desktop staging backup is still in use; retained for later cleanup: ' + $fullStage)
      }
    }
  }
}

try {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This PowerShell packaging entrypoint targets Windows; see apps/desktop/README.md for macOS/Linux native builds.' }
  $lease = Enter-TadaPackagingLease -RepoPath $repoPath
  if ($NodePath) {
    if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) { throw 'NodePath must point to node.exe.' }
    $env:Path = (Split-Path -Parent $NodePath) + [IO.Path]::PathSeparator + $env:Path
  }
  # One explicit writer/path for native outputs. Never use an unaccounted env override.
  $env:CARGO_TARGET_DIR = $targetPath
  $before = Get-TadaStorageUsage -RepoPath $repoPath
  Write-Host ('Retained project paths before build: {0:N2} GB ({1}); temporary build growth is allowed.' -f ($before.TotalBytes / 1e9), $before.Status)
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($targetPath))
  if ($drive.AvailableFreeSpace -lt $EstimatedBuildBytes) { throw ('Insufficient disk space: estimated {0:N2} GB additional space, {1:N2} GB free.' -f ($EstimatedBuildBytes / 1e9), ($drive.AvailableFreeSpace / 1e9)) }
  if (-not (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)) { throw 'pnpm.cmd is required; install the package manager declared by apps/desktop/package.json.' }
  if (-not (Test-Path -LiteralPath (Join-Path $desktopPath 'node_modules/.bin/tauri.cmd'))) { throw 'Desktop dependencies are missing. Run pnpm --dir apps/desktop install --frozen-lockfile before packaging.' }
  if (-not (Test-Path -LiteralPath (Join-Path $repoPath 'apps/client/node_modules'))) { throw 'Shared client dependencies are missing. Run pnpm --dir apps/client install --frozen-lockfile before packaging.' }
  if (-not (Test-Path -LiteralPath (Join-Path $nativePath 'icons/icon.ico'))) { throw 'Desktop icons missing. Generate them with the documented tauri icon command.' }
  Invoke-Checked 'pnpm.cmd' @('--dir',(Join-Path $repoPath 'apps/client'),'typecheck')
  if ($RunRustTests) { Invoke-Checked 'cargo.exe' @('test','--manifest-path',(Join-Path $nativePath 'Cargo.toml'),'--locked','--target',$RustTarget) }
  $arguments = @('--dir',$desktopPath,'build','--target',$RustTarget)
  if ($TauriConfigPath) {
    $resolvedConfig = (Resolve-Path -LiteralPath $TauriConfigPath -ErrorAction Stop).Path
    Assert-TadaPlainPath $resolvedConfig
    if (-not (Test-Path -LiteralPath $resolvedConfig -PathType Leaf)) { throw 'TauriConfigPath must point to a configuration file.' }
    $arguments += @('--config',$resolvedConfig)
  }
  if ($BuildType -eq 'Debug') { $arguments += '--debug' }
  if ($NoBundle) { $arguments += '--no-bundle' } else { $arguments += @('--bundles','nsis') }
  Invoke-Checked 'pnpm.cmd' $arguments
  $profile = if ($BuildType -eq 'Debug') { 'debug' } else { 'release' }
  $binary = Join-Path $targetPath ($RustTarget + '/' + $profile + '/tada-desktop.exe')
  if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw 'Tauri did not produce the expected Windows executable.' }
  $header = [IO.File]::ReadAllBytes($binary)
  if ($header.Length -lt 1024 -or $header[0] -ne 77 -or $header[1] -ne 90) { throw 'Generated file is not a Windows PE executable.' }
  $version = (Get-Content -LiteralPath (Join-Path $nativePath 'tauri.conf.json') -Raw | ConvertFrom-Json).version
  New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
  $candidateDirectory = Join-Path $outputPath 'candidates'
  New-Item -ItemType Directory -Path $candidateDirectory -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $candidate = Join-Path $candidateDirectory ('tada-desktop-v' + $version + '-' + $stamp + '-' + $profile + '.exe')
  Copy-Item -LiteralPath $binary -Destination $candidate
  $candidateHash = (Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($candidateHash -ne (Get-FileHash -LiteralPath $binary -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Candidate copy verification failed.' }
  $installerCopies = @()
  if (-not $NoBundle) {
    $installers = @(Get-ChildItem -LiteralPath (Join-Path $targetPath ($RustTarget + '/' + $profile + '/bundle/nsis')) -File -Filter '*-setup.exe')
    if ($installers.Count -eq 0) { throw 'NSIS installer was requested but no installer was generated.' }
    foreach ($installer in $installers) {
      $destination = Join-Path $candidateDirectory ('tada-desktop-v' + $version + '-' + $stamp + '-setup.exe')
      Copy-Item -LiteralPath $installer.FullName -Destination $destination
      if ((Get-FileHash -LiteralPath $installer.FullName).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) { throw 'Installer copy verification failed.' }
      $installerCopies += $destination
    }
  }
  $delivery = [ordered]@{ version=$version; candidate=$candidate; sha256=$candidateHash; bytes=(Get-Item -LiteralPath $candidate).Length; installers=$installerCopies; code_signed=$false }
  if ($Publish) {
    if ($BuildType -ne 'Release') { throw 'Debug builds are never published as latest.' }
    $delivery.publication = Publish-DesktopBinary -Candidate $candidate -Directory $outputPath -Version $version
  }
  $succeeded = $true
  Write-Host ('Desktop candidate ready: ' + $candidate)
} catch {
  $failure = $_.Exception.Message
  Write-Host ('Desktop build failed: ' + $failure)
} finally {
  # Measure only after the build returned; preserve warm caches below the limit.
  if ($lease) {
    try { $after = Get-TadaStorageUsage -RepoPath $repoPath } catch { $cleanup.Add('Post-build accounting failed: ' + $_.Exception.Message) }
  }
  if ($lease -and ($CleanBuildCache -or ($after -and $after.TotalBytes -gt $after.BudgetBytes))) {
    if (@(Get-TadaActiveBuildProcesses).Count -eq 0 -and (Test-Path -LiteralPath (Join-Path $targetPath 'CACHEDIR.TAG'))) {
      $resolvedTarget = Get-TadaFullPath $targetPath
      if ($resolvedTarget -eq (Get-TadaFullPath (Join-Path $nativePath 'target')) -and (Test-TadaPathInside $resolvedTarget $desktopPath)) {
        try {
          Assert-TadaPlainPath $resolvedTarget
          $scan = [TadaPackagingStorage.Scanner]::Read($resolvedTarget, $true)
          if ($scan.Errors.Count -gt 0 -or $scan.Links.Count -gt 0 -or $scan.Protected.Count -gt 0) { throw 'Target contains protected, unreadable or linked entries.' }
          $tracked = @(& git -C $repoPath ls-files -- 'apps/desktop/src-tauri/target')
          if ($LASTEXITCODE -ne 0 -or $tracked.Count -gt 0) { throw 'Target has tracked source or Git ownership cannot be checked.' }
          $active = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.ExecutablePath -and (Test-TadaPathInside ([string]$_.ExecutablePath) $resolvedTarget)
          })
          if ($active.Count -gt 0) { throw 'An application or test is running from the desktop target; cache is active.' }
          Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
          $removedBytes = $scan.Bytes
          $cleanup.Add('Removed verified owned desktop target after the build finished.')
        } catch { $cleanup.Add('Preserved desktop build cache: ' + $_.Exception.Message) }
      }
    } else { $cleanup.Add('Preserved active, unmarked or unknown-owner desktop build cache.') }
  } else { $cleanup.Add('Warm desktop build cache retained for fast incremental builds; no shared caches were removed.') }
  if ($lease) {
    if ($removedBytes -gt 0) {
      try { $after = Get-TadaStorageUsage -RepoPath $repoPath } catch { $cleanup.Add('Post-cleanup accounting failed: ' + $_.Exception.Message); $after = $null }
    }
    New-Item -ItemType Directory -Path (Join-Path $repoPath 'artifacts') -Force | Out-Null
    $report = [ordered]@{ schema_version=1; retained_target_bytes=20000000000; temporary_excess_allowed=$true; retained_limit_status=$(if (-not $after -or $after.Status -eq 'incomplete') { 'unverified' } elseif ($after.TotalBytes -gt $after.BudgetBytes) { 'exceeded' } else { 'met' }); actual_peak_bytes=$null; estimated_growth_bytes=$EstimatedBuildBytes; before=$before; after=$after; succeeded=$succeeded; error=$failure; delivery=$delivery; cleanup=$cleanup.ToArray(); removed_bytes=$removedBytes }
    [IO.File]::WriteAllText((Join-Path $repoPath 'artifacts/desktop-storage.json'), ($report | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
    $lease.Stream.Dispose()
  }
  $env:Path = $oldPath
  $env:CARGO_TARGET_DIR = $oldTarget
  if ($after) {
    Write-Host ('Retained project paths after build: {0:N2} GB ({1}). See artifacts/desktop-storage.json.' -f ($after.TotalBytes / 1e9), $after.Status)
    if ($after.TotalBytes -gt $after.BudgetBytes) { Write-Warning 'Retained project paths remain above the 20 GB housekeeping limit; preserve active/necessary outputs and review the recorded totals.' }
  }
}
if (-not $succeeded) { throw $failure }
