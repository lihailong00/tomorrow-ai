# Shared by Build-Android.ps1 and the isolated packaging regression tests.
# This file defines functions only: dot-sourcing it never deletes files.

function Get-TadaFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'Storage path must not be empty.' }
  # .NET's process current directory can differ from PowerShell's Set-Location.
  $pathProvider = $null
  $pathDrive = $null
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$pathProvider, [ref]$pathDrive)
  if ($pathProvider.Name -ne 'FileSystem') { throw 'Storage paths must use the filesystem provider.' }
  $full = [IO.Path]::GetFullPath($resolved)
  if ($full -eq [IO.Path]::GetPathRoot($full)) { return $full }
  return $full.TrimEnd([char[]]@('\','/'))
}

function Test-TadaPathInside([string]$Path, [string]$Root) {
  $full = Get-TadaFullPath $Path
  $parent = Get-TadaFullPath $Root
  return $full.Equals($parent, [StringComparison]::OrdinalIgnoreCase) -or
    $full.StartsWith($parent.TrimEnd([char[]]@('\','/')) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-TadaPlainPath([string]$Path) {
  $cursor = Get-TadaFullPath $Path
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $entry = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Refusing reparse path: ' + $cursor) }
    }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
}

function Get-TadaGitCommonDirectory([string]$RepoPath) {
  $result = & git -C $RepoPath rev-parse --path-format=absolute --git-common-dir 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $result) { throw 'Cannot identify the repository common Git directory.' }
  return Get-TadaFullPath ([string]$result)
}

function Get-TadaStorageRoots {
  param([Parameter(Mandatory)][string]$RepoPath, [string[]]$AdditionalPaths = @())
  $repo = Get-TadaFullPath $RepoPath
  $common = Get-TadaGitCommonDirectory $repo
  $roots = [Collections.Generic.List[string]]::new()
  $roots.Add($repo)
  $roots.Add($common)
  # -z avoids Git's quoted-path format for spaces and non-ASCII user names.
  $worktreeText = (& git -C $repo worktree list --porcelain -z 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate linked worktrees; storage accounting would be incomplete.' }
  foreach ($entry in $worktreeText.Split([char]0)) {
    if ($entry.StartsWith('worktree ')) { $roots.Add((Get-TadaFullPath $entry.Substring(9))) }
  }
  # The shared config is measurement-only. It never grants permission to delete.
  $configs = @((Join-Path (Split-Path -Parent $common) '.tada-storage.local.json'), (Join-Path $repo '.tada-storage.local.json')) | Select-Object -Unique
  foreach ($config in $configs) {
    if (-not (Test-Path -LiteralPath $config -PathType Leaf)) { continue }
    Assert-TadaPlainPath $config
    $settings = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if (-not $settings.PSObject.Properties['schema_version'] -or $settings.schema_version -ne 1 -or
        -not $settings.PSObject.Properties['additional_measure_paths']) { throw 'Invalid .tada-storage.local.json.' }
    foreach ($path in @($settings.additional_measure_paths)) {
      if ($path -isnot [string] -or -not [IO.Path]::IsPathRooted($path)) { throw 'Additional measurement paths must be absolute.' }
      $roots.Add((Get-TadaFullPath $path))
    }
  }
  foreach ($path in $AdditionalPaths) { if ($path) { $roots.Add((Get-TadaFullPath $path)) } }
  # A nested worktree or explicitly supplied child directory is already counted.
  $selected = [Collections.Generic.List[string]]::new()
  foreach ($root in ($roots | Sort-Object Length | Select-Object -Unique)) {
    $covered = $false
    foreach ($parent in $selected) { if (Test-TadaPathInside $root $parent) { $covered = $true; break } }
    if (-not $covered) { $selected.Add($root) }
  }
  return $selected.ToArray()
}

function Register-TadaStoragePaths {
  param([Parameter(Mandatory)][string]$RepoPath, [string[]]$AdditionalPaths=@(), [Parameter(Mandatory)]$Lease)
  $repo = Get-TadaFullPath $RepoPath
  if (-not $Lease -or -not $Lease.Stream.CanWrite -or $Lease.RepoPath -ine $repo) { throw 'A live packaging lease is required to register staging paths.' }
  if (@($AdditionalPaths | Where-Object { $_ }).Count -eq 0) { return }
  $common = Get-TadaGitCommonDirectory $repo
  $config = Join-Path (Split-Path -Parent $common) '.tada-storage.local.json'
  Assert-TadaPlainPath $config
  $paths = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $config -PathType Leaf) {
    $settings = Get-Content -LiteralPath $config -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
    if (-not $settings.PSObject.Properties['schema_version'] -or $settings.schema_version -ne 1 -or
        -not $settings.PSObject.Properties['additional_measure_paths']) { throw 'Invalid .tada-storage.local.json; existing configuration preserved.' }
    foreach ($path in @($settings.additional_measure_paths)) {
      if ($path -isnot [string] -or -not [IO.Path]::IsPathRooted($path)) { throw 'Additional measurement paths must be absolute.' }
      $paths.Add((Get-TadaFullPath $path))
    }
  }
  foreach ($path in $AdditionalPaths) { if ($path) { $paths.Add((Get-TadaFullPath $path)) } }
  $record = [ordered]@{ schema_version=1; additional_measure_paths=@($paths | Sort-Object -Unique) }
  $staged = $config + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    [IO.File]::WriteAllText($staged, ($record | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
    Assert-TadaPlainPath $config
    if ([IO.File]::Exists($config)) { [IO.File]::Replace($staged, $config, [NullString]::Value) }
    else { [IO.File]::Move($staged, $config) }
  } finally { if ([IO.File]::Exists($staged)) { [IO.File]::Delete($staged) } }
}

function Initialize-TadaStorageScanner {
  if ('TadaPackagingStorage.Scanner' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
namespace TadaPackagingStorage {
  public sealed class Scan {
    public string Path; public long Bytes; public long Files;
    public List<string> Errors = new List<string>();
    public List<string> Links = new List<string>();
    public List<string> Protected = new List<string>();
  }
  public static class Scanner {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder buffer, uint length, uint flags);
    public static bool LinkIsAlreadyCounted(string path, string[] roots) {
      if (Environment.OSVersion.Platform != PlatformID.Win32NT) return false;
      try {
        using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
          if (handle.IsInvalid) return false;
          var buffer = new StringBuilder(32768);
          uint size = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
          if (size == 0 || size >= buffer.Capacity) return false;
          string target = buffer.ToString();
          if (target.StartsWith(@"\\?\UNC\")) target = @"\\" + target.Substring(8);
          else if (target.StartsWith(@"\\?\")) target = target.Substring(4);
          foreach (string root in roots) {
            if (String.Equals(target, root, StringComparison.OrdinalIgnoreCase) ||
                target.StartsWith(root.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
          }
        }
      } catch { }
      return false;
    }
    public static Scan Read(string root, bool inspectProtected) {
      var result = new Scan { Path = root };
      var pending = new Stack<string>(); pending.Push(root);
      while (pending.Count > 0) {
        string path = pending.Pop();
        try {
          var attributes = File.GetAttributes(path);
          if ((attributes & FileAttributes.ReparsePoint) != 0) { result.Links.Add(path); continue; }
          if ((attributes & FileAttributes.Directory) != 0) {
            if (inspectProtected && String.Equals(Path.GetFileName(path), ".git", StringComparison.OrdinalIgnoreCase)) result.Protected.Add(path);
            foreach (string child in Directory.EnumerateFileSystemEntries(path)) pending.Push(child);
          } else {
            var info = new FileInfo(path); result.Bytes += info.Length; result.Files++;
            if (inspectProtected) {
              string name = info.Name.ToLowerInvariant(), ext = info.Extension.ToLowerInvariant();
              if (name == ".git" || name == ".env" || name.StartsWith(".env.") || name == "id_rsa" || name == "id_ed25519" ||
                  System.Text.RegularExpressions.Regex.IsMatch(name, @"\.(db[0-9]?|sqlite[0-9]?|sqlitedb|realm)(-(wal|shm|journal))?$") ||
                  ext == ".keystore" || ext == ".jks" || ext == ".pem" || ext == ".key" || ext == ".p12" || ext == ".pfx" || ext == ".ppk" || ext == ".cer" || ext == ".crt") result.Protected.Add(path);
            }
          }
        } catch (Exception e) { result.Errors.Add(path + ": " + e.GetType().Name); }
      }
      return result;
    }
  }
}
'@
}

function Get-TadaStorageUsage {
  param(
    [Parameter(Mandatory)][string]$RepoPath,
    [string[]]$AdditionalPaths = @(),
    [long]$BudgetBytes = 10000000000,
    [long]$WarningBytes = 9000000000
  )
  if ($BudgetBytes -le 0 -or $WarningBytes -lt 0 -or $WarningBytes -gt $BudgetBytes) { throw 'Invalid storage thresholds.' }
  Initialize-TadaStorageScanner
  $measurements = [Collections.Generic.List[object]]::new()
  $errors = [Collections.Generic.List[string]]::new()
  $links = [Collections.Generic.List[string]]::new()
  [long]$coveredLinks = 0
  [long]$total = 0
  $roots = @(Get-TadaStorageRoots -RepoPath $RepoPath -AdditionalPaths $AdditionalPaths)
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) {
      $measurements.Add([pscustomobject]@{ Path=$root; Bytes=0; Files=0; Missing=$true }); continue
    }
    try { Assert-TadaPlainPath $root } catch { $errors.Add($_.Exception.Message); continue }
    $scan = [TadaPackagingStorage.Scanner]::Read($root, $false)
    $total += $scan.Bytes
    $measurements.Add([pscustomobject]@{ Path=$root; Bytes=$scan.Bytes; Files=$scan.Files; Missing=$false })
    foreach ($errorText in $scan.Errors) { $errors.Add($errorText) }
    foreach ($link in $scan.Links) {
      if ([TadaPackagingStorage.Scanner]::LinkIsAlreadyCounted($link, [string[]]$roots)) { $coveredLinks++ }
      else { $links.Add($link) }
    }
  }
  $status = if ($errors.Count -gt 0 -or $links.Count -gt 0) { 'incomplete' } elseif ($total -gt $BudgetBytes) { 'over_budget' } elseif ($total -ge $WarningBytes) { 'warning' } else { 'within_budget' }
  return [pscustomobject]@{
    MeasuredAt=[DateTimeOffset]::UtcNow.ToString('o'); TotalBytes=$total; BudgetBytes=$BudgetBytes; WarningBytes=$WarningBytes
    Status=$status; Roots=$measurements.ToArray(); Errors=@($errors | Select-Object -First 100); SkippedLinks=@($links | Select-Object -First 100)
    ErrorCount=$errors.Count; SkippedLinkCount=$links.Count; AlreadyCountedLinkCount=$coveredLinks
    Measurement='Logical file lengths; nested paths deduplicated; hardlinks may be conservatively counted more than once; reparse targets are not traversed.'
    SeparatelyAccounted=@('Shared SDKs/toolchains and shared global dependency caches', 'Docker images, build cache and volumes (not inventoried by this path scanner)')
  }
}

function Write-TadaStorageStatus {
  param([Parameter(Mandatory)]$Usage, [string]$Phase, [long]$EstimatedBuildBytes=0)
  Write-Host ('Storage {0}: {1:N2} GB / {2:N0} GB ({3}).' -f $Phase, ($Usage.TotalBytes / 1e9), ($Usage.BudgetBytes / 1e9), $Usage.Status)
  if ($Usage.TotalBytes -ge $Usage.WarningBytes) { Write-Warning 'Project storage is near or above the 10 GB target; safe rebuildable outputs will be reclaimed where possible.' }
  if ($EstimatedBuildBytes -gt 0 -and ($Usage.TotalBytes + $EstimatedBuildBytes) -gt $Usage.BudgetBytes) {
    Write-Warning ('Estimated build peak: {0:N2} GB. This may exceed the target temporarily; post-build housekeeping is mandatory.' -f (($Usage.TotalBytes + $EstimatedBuildBytes) / 1e9))
  }
  if ($Usage.Status -eq 'incomplete') { Write-Warning 'Some paths could not be measured or contain reparse links. Do not treat this total as complete.' }
}

function Enter-TadaPackagingLease {
  param([Parameter(Mandatory)][string]$RepoPath, [ValidateRange(0,120)][int]$TimeoutSeconds=10)
  $repo = Get-TadaFullPath $RepoPath
  Assert-TadaPlainPath $repo
  $common = Get-TadaGitCommonDirectory $repo
  Assert-TadaPlainPath $common
  $lockPath = Join-Path $common 'tada-android-build.lock'
  Assert-TadaPlainPath $lockPath
  $watch = [Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    try {
      $stream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
      return [pscustomobject]@{ RepoPath=$repo; Stream=$stream; LockPath=$lockPath; StartedAt=[DateTimeOffset]::UtcNow.ToString('o') }
    } catch [IO.IOException] {
      if ($watch.Elapsed.TotalSeconds -ge $TimeoutSeconds) { throw 'Another linked worktree is packaging. No cleanup or build was started.' }
      Start-Sleep -Milliseconds 100
    }
  }
}

function Write-TadaCleanupStatus {
  param([Parameter(Mandatory)]$Cleanup)
  $removed = @($Cleanup.Items | Where-Object Status -eq 'removed').Count
  $skipped = @($Cleanup.Items | Where-Object Status -ne 'removed').Count
  Write-Host ('Cache cleanup {0}: {1} removed, {2} skipped, {3:N2} GB reclaimed.' -f $Cleanup.Phase, $removed, $skipped, ($Cleanup.RemovedBytes / 1e9))
  if ($skipped -gt 0) { Write-Warning 'Caches were preserved because they are active, locked, unowned or contain protected data. See the storage report for each reason; no background processes were stopped.' }
}

function Get-TadaActiveBuildProcesses {
  # A process using uncoordinated Gradle/CMake/Cargo can bypass our lease. Be
  # conservative even when its command line does not identify a workspace.
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return @([pscustomobject]@{ Name='process-inspection-unavailable' }) }
  try {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      ($_.Name -match '^(java|javaw)\.exe$' -and ([string]::IsNullOrWhiteSpace($_.CommandLine) -or $_.CommandLine -match '(?i)gradle|kotlin|cmake')) -or
      $_.Name -match '^(cargo|rustc|cmake|ninja|clang|clang\+\+|aapt2)\.exe$'
    } | Select-Object ProcessId,Name)
  } catch { return @([pscustomobject]@{ Name='process-inspection-unavailable' }) }
}

function Initialize-TadaNativeBuildDirectory {
  param([Parameter(Mandatory)][string]$RepoPath, [Parameter(Mandatory)][string]$NativeBuildDirectory)
  $repo = Get-TadaFullPath $RepoPath
  $native = Get-TadaFullPath $NativeBuildDirectory
  Assert-TadaPlainPath $native
  if ((Test-TadaPathInside $repo $native) -or (Test-TadaPathInside $native $repo)) {
    # Internal staging is counted but custom directories are not automatically deleted.
    return
  }
  $parent = Split-Path -Parent $native
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'Native staging parent directory does not exist.' }
  $marker = Join-Path $native '.tada-build-owner.json'
  if (Test-Path -LiteralPath $native) {
    if (@(Get-ChildItem -LiteralPath $native -Force -ErrorAction Stop).Count -gt 0) { return }
  } else { New-Item -ItemType Directory -Path $native -ErrorAction Stop | Out-Null }
  $record = [ordered]@{ schema_version=1; purpose='android-native-staging'; repo_path=$repo; path=$native }
  [IO.File]::WriteAllText($marker, ($record | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}

function Invoke-TadaBuildCacheCleanup {
  param(
    [Parameter(Mandatory)][string]$RepoPath,
    [string]$NativeBuildDirectory,
    [Parameter(Mandatory)]$Lease,
    [ValidateSet('Preflight','Success','Failure')][string]$Phase,
    [switch]$IncludeRustTarget
  )
  $repo = Get-TadaFullPath $RepoPath
  if (-not $Lease -or -not $Lease.Stream -or -not $Lease.Stream.CanWrite -or $Lease.RepoPath -ine $repo) { throw 'A live packaging lease for this worktree is required for cleanup.' }
  Initialize-TadaStorageScanner
  $results = [Collections.Generic.List[object]]::new()
  $candidates = [Collections.Generic.List[string]]::new()
  foreach ($relative in @('apps/mobile/android/app/build','apps/mobile/android/build','apps/mobile/android/app/.cxx','apps/mobile/android/.gradle')) { $candidates.Add((Join-Path $repo $relative)) }
  if ($IncludeRustTarget) {
    $target = Join-Path $repo 'target'
    if (Test-Path -LiteralPath (Join-Path $target 'CACHEDIR.TAG') -PathType Leaf) { $candidates.Add($target) }
  }
  if ($NativeBuildDirectory) {
    $native = Get-TadaFullPath $NativeBuildDirectory
    $marker = Join-Path $native '.tada-build-owner.json'
    try {
      Assert-TadaPlainPath $native
      if (Test-Path -LiteralPath $marker -PathType Leaf) {
        $owner = Get-Content -LiteralPath $marker -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ($owner.schema_version -eq 1 -and $owner.purpose -ceq 'android-native-staging' -and
            $owner.repo_path -ieq $repo -and $owner.path -ieq $native -and -not (Test-TadaPathInside $repo $native) -and -not (Test-TadaPathInside $native $repo)) { $candidates.Add($native) }
        else { $results.Add([pscustomobject]@{ Path=$native; Status='skipped-unowned'; Bytes=0 }) }
      } elseif (Test-Path -LiteralPath $native) { $results.Add([pscustomobject]@{ Path=$native; Status='skipped-unowned'; Bytes=0 }) }
    } catch { $results.Add([pscustomobject]@{ Path=$native; Status='skipped-unsafe'; Bytes=0; Reason=$_.Exception.Message }) }
  }
  $trackedText = (& git -C $repo ls-files -z 2>$null) -join "`n"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot check tracked files; no cache cleanup performed.' }
  $tracked = @($trackedText.Split([char]0) | Where-Object { $_ })
  foreach ($candidate in $candidates) {
    $path = Get-TadaFullPath $candidate
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
      Assert-TadaPlainPath $repo
      Assert-TadaPlainPath $path
      $inside = Test-TadaPathInside $path $repo
      $allowedInternal = @('apps/mobile/android/app/build','apps/mobile/android/build','apps/mobile/android/app/.cxx','apps/mobile/android/.gradle','target') | ForEach-Object { Get-TadaFullPath (Join-Path $repo $_) }
      if ($inside -and $path -inotmatch ('^(' + (($allowedInternal | ForEach-Object { [regex]::Escape($_) }) -join '|') + ')$')) { throw 'Cache path is not in the fixed allowlist.' }
      foreach ($relative in $tracked) {
        if (Test-TadaPathInside (Join-Path $repo $relative) $path) { throw 'Cache contains a tracked source file.' }
      }
      $scan = [TadaPackagingStorage.Scanner]::Read($path, $true)
      if ($scan.Errors.Count -gt 0 -or $scan.Links.Count -gt 0 -or $scan.Protected.Count -gt 0) { throw 'Cache contains unreadable, linked or protected data; preserve it for manual review.' }
      if (@(Get-TadaActiveBuildProcesses).Count -gt 0) {
        $results.Add([pscustomobject]@{ Path=$path; Status='skipped-active-build'; Bytes=0 }); continue
      }
      # Recheck both boundary and directory attributes immediately before deletion.
      Assert-TadaPlainPath $path
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      $results.Add([pscustomobject]@{ Path=$path; Status='removed'; Bytes=$scan.Bytes })
    } catch { $results.Add([pscustomobject]@{ Path=$path; Status='skipped-unsafe-or-locked'; Bytes=0; Reason=$_.Exception.Message }) }
  }
  [long]$removedBytes = 0
  foreach ($item in $results) { if ($item.Status -eq 'removed') { $removedBytes += $item.Bytes } }
  return [pscustomobject]@{ Phase=$Phase; Items=$results.ToArray(); RemovedBytes=$removedBytes }
}
