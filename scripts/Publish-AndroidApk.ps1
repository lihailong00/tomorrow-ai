[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ApkPath,
  [string]$OutputDirectory,
  [string]$AndroidHome,
  [string]$AaptPath,
  [string]$ExpectedPackage = 'com.tomorrowai',
  [ValidateRange(1,120)][int]$LockTimeoutSeconds = 30,
  [switch]$ResetRollback
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Find-Aapt {
  if ($AaptPath) {
    if (-not (Test-Path -LiteralPath $AaptPath -PathType Leaf)) { throw '指定的 aapt 不存在。' }
    return (Resolve-Path -LiteralPath $AaptPath).Path
  }
  $sdkCandidates = [System.Collections.Generic.List[string]]::new()
  foreach ($candidate in @($AndroidHome,$env:ANDROID_HOME,$env:ANDROID_SDK_ROOT,(Join-Path $env:LOCALAPPDATA 'Android/Sdk'))) {
    if ($candidate) { $sdkCandidates.Add($candidate) }
  }
  foreach ($drive in Get-PSDrive -PSProvider FileSystem) { $sdkCandidates.Add((Join-Path $drive.Root 'Android/Sdk')) }
  foreach ($sdk in $sdkCandidates) {
    $tools = Join-Path $sdk 'build-tools'
    if (-not (Test-Path -LiteralPath $tools -PathType Container)) { continue }
    foreach ($buildTool in Get-ChildItem -LiteralPath $tools -Directory | Sort-Object @{ Expression = { try { [version]($_.Name -replace '-.*$','') } catch { [version]'0.0' } }; Descending = $true }) {
      foreach ($name in @('aapt.exe','aapt')) {
        $candidate = Join-Path $buildTool.FullName $name
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
      }
    }
  }
  $command = Get-Command aapt -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  throw '未找到 aapt，无法验证 APK 的真实版本。请传入 -AndroidHome 或 -AaptPath。'
}

function Read-ApkVersion([string]$Path) {
  $output = & $script:aapt dump badging $Path 2>&1
  if ($LASTEXITCODE -ne 0) { throw ('无法读取 APK 的真实版本：' + [IO.Path]::GetFileName($Path)) }
  $packageLine = @($output | Where-Object { [string]$_ -match '^package: ' } | Select-Object -First 1)
  if ($packageLine.Count -ne 1) { throw 'APK 缺少有效的 Android 包信息。' }
  $fields = @{}
  foreach ($match in [regex]::Matches([string]$packageLine[0], "(?<key>[A-Za-z][A-Za-z0-9]*)='(?<value>[^']*)'")) { $fields[$match.Groups['key'].Value] = $match.Groups['value'].Value }
  $code = 0L
  if (-not $fields.ContainsKey('name') -or -not $fields.ContainsKey('versionCode') -or
      -not [long]::TryParse($fields['versionCode'], [ref]$code) -or $code -lt 1 -or $code -gt 2100000000) {
    throw 'APK 的 versionCode 无效，已停止更新最新版。'
  }
  if ($fields['name'] -cne $ExpectedPackage) { throw 'APK 包名与当前应用不一致，已停止更新最新版。' }
  return [pscustomobject]@{ Package = $fields['name']; VersionCode = $code; VersionName = $(if ($fields.ContainsKey('versionName')) { $fields['versionName'] } else { '' }) }
}

function Get-PublishFullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'APK 发布路径不能为空。' }
  # Resolve relative paths against PowerShell's location, which can differ from
  # the process current directory used by System.IO.Path.GetFullPath.
  $provider = $null
  $drive = $null
  $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path, [ref]$provider, [ref]$drive)
  if ($provider.Name -ne 'FileSystem') { throw 'APK 发布路径必须属于文件系统。' }
  return [IO.Path]::GetFullPath($resolved)
}

function Assert-OutputFile([string]$Path) {
  $fullPath = Get-PublishFullPath $Path
  if (-not $fullPath.StartsWith($script:outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not [string]::Equals([IO.Path]::GetDirectoryName($fullPath).TrimEnd('\','/'), $script:outputPath.TrimEnd('\','/'), [StringComparison]::OrdinalIgnoreCase)) {
    throw '发布临时文件不在指定的输出目录中。'
  }
  Assert-NoReparsePoint $fullPath
}

function Assert-NoReparsePoint([string]$Path) {
  # Resolve-Path alone follows junctions. Inspect every existing component before
  # creating, copying, replacing or deleting anything in the delivery folder.
  $cursor = Get-PublishFullPath $Path
  while ($cursor) {
    $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
    if ($item -and (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw 'APK 发布路径中存在链接或目录联接，已停止以保护其他目录。'
    }
    $parent = [IO.Path]::GetDirectoryName($cursor.TrimEnd('\','/'))
    if (-not $parent -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Read-ApkSnapshotInfo([string]$Path) {
  Assert-NoReparsePoint $Path
  $version = Read-ApkVersion $Path
  return [pscustomobject]@{
    Package = $version.Package
    VersionCode = $version.VersionCode
    VersionName = $version.VersionName
    Sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
    SizeBytes = (Get-Item -LiteralPath $Path -Force).Length
    Path = $Path
  }
}

function Assert-MatchingRecord($Record, $Info, [string]$Label) {
  $code = 0L
  if (-not $Record -or -not $Record.PSObject.Properties['package_name'] -or
      $Record.package_name -cne $ExpectedPackage -or -not $Record.PSObject.Properties['version_code'] -or
      -not [long]::TryParse([string]$Record.version_code, [ref]$code) -or $code -ne $Info.VersionCode -or
      -not $Record.PSObject.Properties['sha256'] -or [string]$Record.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
      [string]$Record.sha256 -ine $Info.Sha256) {
    throw ($Label + ' 元数据与实际 APK 不一致，已停止更新。')
  }
  if ($Record.PSObject.Properties['size_bytes'] -and [long]$Record.size_bytes -ne $Info.SizeBytes) {
    throw ($Label + ' 文件长度与元数据不一致，已停止更新。')
  }
}

function Test-GeneratedApkName([string]$Name) {
  return $Name -cmatch '^tada-v[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?-[0-9]{8}-[0-9]{6}-[0-9]{3}\.apk$'
}

function Remove-OldGeneratedApks($Incoming, [string]$SourcePath, [string]$PreviousSourceName, $Rollback) {
  $removed = [System.Collections.Generic.List[string]]::new()
  $skipped = [System.Collections.Generic.List[object]]::new()
  $freed = 0L
  # A publisher may be waiting for the folder lock with a newly prepared input.
  # Only the previous committed source is immediately eligible; other files need
  # a one-hour grace period and must have a strictly lower Android versionCode.
  # A same-code prior committed source is redundant only when its exact bytes
  # have been verified in either the retained rollback or the new latest.
  foreach ($file in Get-ChildItem -LiteralPath $script:outputPath -File -Force) {
    if (-not (Test-GeneratedApkName $file.Name) -or [string]::Equals($file.FullName,$SourcePath,[StringComparison]::OrdinalIgnoreCase)) { continue }
    try {
      Assert-OutputFile $file.FullName
      $isPreviousSource = $PreviousSourceName -and $file.Name -ceq $PreviousSourceName
      if (-not $isPreviousSource -and $file.LastWriteTimeUtc -gt $script:publishStarted.AddHours(-1)) {
        $skipped.Add([pscustomobject]@{ Path = $file.FullName; Reason = 'recent_or_pending_publication' }); continue
      }
      # The stream prevents writes during inspection. The publication lock and
      # age/version guards exclude inputs of other cooperating publishers.
      $guard = $null
      try {
        $guard = [IO.File]::Open($file.FullName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $info = Read-ApkSnapshotInfo $file.FullName
        $knownPreviousCopy = $isPreviousSource -and ($info.Sha256 -ceq $Incoming.Sha256 -or ($Rollback -and $info.Sha256 -ceq $Rollback.Sha256))
        if ($info.VersionCode -gt $Incoming.VersionCode -or ($info.VersionCode -eq $Incoming.VersionCode -and -not $knownPreviousCopy)) {
          $skipped.Add([pscustomobject]@{ Path = $file.FullName; Reason = 'current_or_newer_version' }); continue
        }
        if ($isPreviousSource -and -not $knownPreviousCopy) {
          $skipped.Add([pscustomobject]@{ Path = $file.FullName; Reason = 'previous_source_not_verified_in_retained_packages' }); continue
        }
      } finally { if ($guard) { $guard.Dispose() } }
      Assert-OutputFile $file.FullName
      # Delete only this exact known generated file. Failure never rolls back a
      # successful publication, and no wildcard or recursive deletion is used.
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction Stop
      $removed.Add($file.FullName)
      $freed += $info.SizeBytes
    } catch {
      $skipped.Add([pscustomobject]@{ Path = $file.FullName; Reason = 'unsafe_invalid_foreign_or_in_use' })
    }
  }
  if ($skipped.Count -gt 0) { Write-Warning ('保留了 ' + $skipped.Count + ' 个可能正在使用、尚待发布或无法确认的 APK；详见 Cleanup.SkippedFiles。') }
  return [pscustomobject]@{ RemovedFiles = @($removed.ToArray()); SkippedFiles = @($skipped.ToArray()); FreedBytes = $freed }
}

function Copy-Snapshot([string]$Source, [string]$Destination) {
  Assert-NoReparsePoint $Source
  Assert-OutputFile $Destination
  $inputStream = $null
  $outputStream = $null
  try {
    # Disallow a concurrent overwrite/delete while the selected APK is copied.
    $inputStream = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $outputStream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $inputStream.CopyTo($outputStream)
    $outputStream.Flush($true)
  } finally {
    if ($outputStream) { $outputStream.Dispose() }
    if ($inputStream) { $inputStream.Dispose() }
  }
}

function Replace-PublishedFile([string]$Staged, [string]$Destination, [string]$Backup) {
  foreach ($path in @($Staged,$Destination,$Backup)) { Assert-OutputFile $path }
  $existed = [IO.File]::Exists($Destination)
  if ($existed) { [IO.File]::Replace($Staged, $Destination, $Backup, $true) }
  else { [IO.File]::Move($Staged, $Destination) }
  $script:replaced.Add([pscustomobject]@{ Destination = $Destination; Backup = $Backup; Existed = $existed })
}

Assert-NoReparsePoint $ApkPath
if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) { throw '待发布 APK 不存在。' }
$sourcePath = (Resolve-Path -LiteralPath $ApkPath).Path
if ([IO.Path]::GetExtension($sourcePath) -ine '.apk') { throw '请选择 .apk 安装包。' }
if (-not $OutputDirectory) { $OutputDirectory = Split-Path -Parent $sourcePath }
$script:outputPath = Get-PublishFullPath $OutputDirectory
Assert-NoReparsePoint $script:outputPath
New-Item -ItemType Directory -Path $script:outputPath -Force | Out-Null
$script:outputPath = (Resolve-Path -LiteralPath $script:outputPath).Path
$script:outputPrefix = $script:outputPath.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$script:aapt = Find-Aapt
$id = [Guid]::NewGuid().ToString('N')
$prefix = Join-Path $script:outputPath ('.apk-publish-' + $id)
$firstStage = $prefix + '-tada.apk'
$secondStage = $prefix + '-legacy.apk'
$rollbackStage = $prefix + '-rollback.apk'
$metadataStage = $prefix + '-latest.json'
$latestPath = Join-Path $script:outputPath 'tada-latest.apk'
$legacyPath = Join-Path $script:outputPath 'tomorrow-ai-latest.apk'
$rollbackPath = Join-Path $script:outputPath 'tada-rollback.apk'
$metadataPath = Join-Path $script:outputPath 'latest.json'
$lockPath = Join-Path $script:outputPath '.publish-android.lock'
$temporaryFiles = @($firstStage,$secondStage,$rollbackStage,$metadataStage,($prefix + '-tada.backup'),($prefix + '-legacy.backup'),($prefix + '-rollback.backup'),($prefix + '-metadata.backup'),($prefix + '-tada.backup.replaced'),($prefix + '-legacy.backup.replaced'),($prefix + '-rollback.backup.replaced'),($prefix + '-metadata.backup.replaced'))
$script:replaced = [System.Collections.Generic.List[object]]::new()
$lock = $null
$keepBackups = $false
$published = $false
$script:publishStarted = [DateTime]::UtcNow

try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not $lock) {
    Assert-OutputFile $lockPath
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if ($timer.Elapsed.TotalSeconds -ge $LockTimeoutSeconds) { throw '其他构建正在更新最新版，请稍后重新发布。' }
      Start-Sleep -Milliseconds 100
    }
  }
  Copy-Snapshot $sourcePath $firstStage
  $incoming = Read-ApkSnapshotInfo $firstStage
  $sha = $incoming.Sha256
  $latestCode = 0L
  $previous = $null
  $previousMetadata = $null
  $previousSourceName = $null
  $rollback = $null
  $replaceRollback = $false
  foreach ($existing in @($latestPath,$legacyPath)) {
    Assert-OutputFile $existing
    if ([IO.File]::Exists($existing)) {
      $version = Read-ApkSnapshotInfo $existing
      if ($previous -and ($previous.Sha256 -cne $version.Sha256 -or $previous.VersionCode -ne $version.VersionCode)) {
        throw '两个 latest APK 不一致，请先检查已有发布文件；已保留原文件。'
      }
      $previous = $version
      if ($version.VersionCode -gt $latestCode) { $latestCode = $version.VersionCode }
    }
  }
  Assert-OutputFile $metadataPath
  if ([IO.File]::Exists($metadataPath)) {
    try { $previousMetadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json }
    catch { throw 'latest.json 无法读取，已停止更新以保护当前最新版。' }
    if (-not $previous) { throw 'latest.json 存在但 latest APK 已缺失，已停止更新以保护发布记录。' }
    Assert-MatchingRecord $previousMetadata $previous 'latest.json'
    if ($previousMetadata.PSObject.Properties['source_filename']) {
      $previousSourceName = [string]$previousMetadata.source_filename
      if ([IO.Path]::GetFileName($previousSourceName) -cne $previousSourceName -or
          $previousSourceName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0) {
        throw 'latest.json 的来源文件名无效，已停止更新。'
      }
    }
  }
  Assert-OutputFile $rollbackPath
  if ([IO.File]::Exists($rollbackPath)) {
    $rollback = Read-ApkSnapshotInfo $rollbackPath
    if ($previous -and $rollback.VersionCode -gt $previous.VersionCode) { throw '回退 APK 版本高于当前最新版，已停止更新。' }
    if ($previousMetadata -and $previousMetadata.PSObject.Properties['rollback'] -and $previousMetadata.rollback) {
      if (-not $previousMetadata.rollback.PSObject.Properties['filename'] -or $previousMetadata.rollback.filename -cne 'tada-rollback.apk') { throw '回退 APK 文件名记录无效。' }
      Assert-MatchingRecord $previousMetadata.rollback $rollback '回退 APK'
    }
  } elseif ($previousMetadata -and $previousMetadata.PSObject.Properties['rollback'] -and $previousMetadata.rollback) {
    throw '已记录的回退 APK 缺失，已停止更新。'
  }
  if ($incoming.VersionCode -lt $latestCode) {
    return [pscustomobject]@{ Published = $false; Reason = 'older_version'; VersionCode = $incoming.VersionCode; LatestVersionCode = $latestCode; ApkPath = $sourcePath; LatestApkPath = $latestPath; MetadataPath = $metadataPath; RollbackApkPath = $(if ($rollback) { $rollbackPath } else { $null }); Cleanup = [pscustomobject]@{ RemovedFiles = @(); SkippedFiles = @(); FreedBytes = 0L } }
  }

  if ($ResetRollback) {
    $rollback = $null
  } elseif ($previous -and $previous.Sha256 -cne $sha) {
    $rollback = $previous
    $replaceRollback = $true
  } elseif (-not $rollback -and $previous -and
      (-not $previousMetadata -or -not $previousMetadata.PSObject.Properties['rollback'])) {
    # Upgrade an old schema-1 output folder without discarding its older usable
    # package. Unknown/newborn inputs are not adopted as a trusted rollback.
    foreach ($candidate in Get-ChildItem -LiteralPath $script:outputPath -File -Force) {
      if (-not (Test-GeneratedApkName $candidate.Name) -or $candidate.LastWriteTimeUtc -gt $script:publishStarted.AddHours(-1)) { continue }
      try {
        Assert-OutputFile $candidate.FullName
        $info = Read-ApkSnapshotInfo $candidate.FullName
        if ($info.VersionCode -lt $incoming.VersionCode -and (-not $rollback -or $info.VersionCode -gt $rollback.VersionCode)) { $rollback = $info; $replaceRollback = $true }
      } catch { continue }
    }
  }
  if ($replaceRollback) {
    Copy-Snapshot $rollback.Path $rollbackStage
    if ((Get-FileHash -LiteralPath $rollbackStage -Algorithm SHA256).Hash.ToLowerInvariant() -cne $rollback.Sha256) { throw '回退 APK 暂存校验失败，已停止更新。' }
  }
  Copy-Snapshot $firstStage $secondStage
  if ((Get-FileHash -LiteralPath $secondStage -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw 'APK 暂存副本校验失败，已停止更新。' }
  $metadata = [ordered]@{
    schema_version = 2
    package_name = $incoming.Package
    version_code = $incoming.VersionCode
    version_name = $incoming.VersionName
    sha256 = $sha
    size_bytes = (Get-Item -LiteralPath $firstStage).Length
    source_filename = [IO.Path]::GetFileName($sourcePath)
    published_at = [DateTimeOffset]::UtcNow.ToString('o')
    aliases = @('tada-latest.apk','tomorrow-ai-latest.apk')
    rollback = $(if ($rollback) {
      [ordered]@{ filename = 'tada-rollback.apk'; package_name = $rollback.Package; version_code = $rollback.VersionCode; version_name = $rollback.VersionName; sha256 = $rollback.Sha256; size_bytes = $rollback.SizeBytes }
    } else { $null })
  }
  Assert-OutputFile $metadataStage
  [IO.File]::WriteAllText($metadataStage, (($metadata | ConvertTo-Json -Depth 4) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  # Each replacement is atomic on this filesystem. The folder lock serializes
  # writers; metadata commits last, and any failed replacement restores aliases.
  Replace-PublishedFile $firstStage $latestPath ($prefix + '-tada.backup')
  Replace-PublishedFile $secondStage $legacyPath ($prefix + '-legacy.backup')
  $rollbackBackup = $prefix + '-rollback.backup'
  if ($replaceRollback) {
    Replace-PublishedFile $rollbackStage $rollbackPath $rollbackBackup
  } elseif ($ResetRollback -and [IO.File]::Exists($rollbackPath)) {
    Assert-OutputFile $rollbackPath
    Assert-OutputFile $rollbackBackup
    [IO.File]::Move($rollbackPath, $rollbackBackup)
    $script:replaced.Add([pscustomobject]@{ Destination = $rollbackPath; Backup = $rollbackBackup; Removed = $true })
  }
  Replace-PublishedFile $metadataStage $metadataPath ($prefix + '-metadata.backup')
  foreach ($alias in @($latestPath,$legacyPath)) {
    Assert-OutputFile $alias
    if ((Get-FileHash -LiteralPath $alias -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw '发布后的 latest APK 校验失败，正在恢复原发布。' }
  }
  if ($rollback) {
    Assert-OutputFile $rollbackPath
    if ((Get-FileHash -LiteralPath $rollbackPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne $rollback.Sha256) { throw '发布后的回退 APK 校验失败，正在恢复原发布。' }
  }
  $committed = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-MatchingRecord $committed $incoming '发布后的 latest.json'
  $published = $true
  try { $cleanup = Remove-OldGeneratedApks $incoming $sourcePath $previousSourceName $rollback }
  catch {
    Write-Warning '最新版和回退 APK 已通过校验，但旧包清理未完成；已保留无法确认的文件。'
    $cleanup = [pscustomobject]@{ RemovedFiles = @(); SkippedFiles = @([pscustomobject]@{ Path = $script:outputPath; Reason = 'cleanup_incomplete' }); FreedBytes = 0L }
  }
  return [pscustomobject]@{ Published = $true; Reason = 'published'; VersionCode = $incoming.VersionCode; LatestVersionCode = $incoming.VersionCode; VersionName = $incoming.VersionName; Sha256 = $sha; ApkPath = $sourcePath; LatestApkPath = $latestPath; MetadataPath = $metadataPath; RollbackApkPath = $(if ($rollback) { $rollbackPath } else { $null }); Cleanup = $cleanup }
} catch {
  $failure = $_
  if (-not $published -and $script:replaced.Count -gt 0) {
    for ($index = $script:replaced.Count - 1; $index -ge 0; $index--) {
      $item = $script:replaced[$index]
      try {
        if ($item.PSObject.Properties['Removed']) {
          [IO.File]::Move($item.Backup, $item.Destination)
        } elseif ($item.Existed) {
          $displaced = $item.Backup + '.replaced'
          Assert-OutputFile $displaced
          [IO.File]::Replace($item.Backup, $item.Destination, $displaced, $true)
        }
        else { [IO.File]::Delete($item.Destination) }
      } catch { $keepBackups = $true }
    }
  }
  if ($keepBackups) { throw ('更新失败且自动恢复未完成，请保留输出目录中的 .apk-publish-' + $id + '* 备份文件后检查。') }
  throw $failure
} finally {
  try {
    foreach ($temporary in $temporaryFiles) {
      Assert-OutputFile $temporary
      if (-not $keepBackups -and [IO.File]::Exists($temporary)) {
        try { [IO.File]::Delete($temporary) }
        catch { Write-Warning '发布临时文件暂时无法清理，可稍后删除输出目录中的 .apk-publish 临时文件。' }
      }
    }
  } finally {
    if ($lock) { $lock.Dispose() }
  }
}
