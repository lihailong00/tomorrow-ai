[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ApkPath,
  [string]$OutputDirectory,
  [string]$AndroidHome,
  [string]$AaptPath,
  [string]$ExpectedPackage = 'com.tomorrowai',
  [ValidateRange(1,120)][int]$LockTimeoutSeconds = 30
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

function Assert-OutputFile([string]$Path) {
  $fullPath = [IO.Path]::GetFullPath($Path)
  if (-not $fullPath.StartsWith($script:outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetDirectoryName($fullPath).TrimEnd('\','/') -cne $script:outputPath.TrimEnd('\','/')) {
    throw '发布临时文件不在指定的输出目录中。'
  }
}

function Copy-Snapshot([string]$Source, [string]$Destination) {
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

if (-not (Test-Path -LiteralPath $ApkPath -PathType Leaf)) { throw '待发布 APK 不存在。' }
$sourcePath = (Resolve-Path -LiteralPath $ApkPath).Path
if ([IO.Path]::GetExtension($sourcePath) -ine '.apk') { throw '请选择 .apk 安装包。' }
if (-not $OutputDirectory) { $OutputDirectory = Split-Path -Parent $sourcePath }
$script:outputPath = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $script:outputPath -Force | Out-Null
$script:outputPath = (Resolve-Path -LiteralPath $script:outputPath).Path
$script:outputPrefix = $script:outputPath.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$script:aapt = Find-Aapt
$id = [Guid]::NewGuid().ToString('N')
$prefix = Join-Path $script:outputPath ('.apk-publish-' + $id)
$firstStage = $prefix + '-tada.apk'
$secondStage = $prefix + '-legacy.apk'
$metadataStage = $prefix + '-latest.json'
$latestPath = Join-Path $script:outputPath 'tada-latest.apk'
$legacyPath = Join-Path $script:outputPath 'tomorrow-ai-latest.apk'
$metadataPath = Join-Path $script:outputPath 'latest.json'
$lockPath = Join-Path $script:outputPath '.publish-android.lock'
$temporaryFiles = @($firstStage,$secondStage,$metadataStage,($prefix + '-tada.backup'),($prefix + '-legacy.backup'),($prefix + '-metadata.backup'),($prefix + '-tada.backup.replaced'),($prefix + '-legacy.backup.replaced'),($prefix + '-metadata.backup.replaced'))
$script:replaced = [System.Collections.Generic.List[object]]::new()
$lock = $null
$keepBackups = $false
$published = $false

try {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  while (-not $lock) {
    try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] {
      if ($timer.Elapsed.TotalSeconds -ge $LockTimeoutSeconds) { throw '其他构建正在更新最新版，请稍后重新发布。' }
      Start-Sleep -Milliseconds 100
    }
  }
  Copy-Snapshot $sourcePath $firstStage
  $incoming = Read-ApkVersion $firstStage
  $latestCode = 0L
  foreach ($existing in @($latestPath,$legacyPath)) {
    if ([IO.File]::Exists($existing)) {
      $version = Read-ApkVersion $existing
      if ($version.VersionCode -gt $latestCode) { $latestCode = $version.VersionCode }
    }
  }
  if ([IO.File]::Exists($metadataPath)) {
    try { $previousMetadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json }
    catch { throw 'latest.json 无法读取，已停止更新以保护当前最新版。' }
    $recordedCode = 0L
    if (-not $previousMetadata.PSObject.Properties['package_name'] -or $previousMetadata.package_name -cne $ExpectedPackage -or
        -not $previousMetadata.PSObject.Properties['version_code'] -or -not [long]::TryParse([string]$previousMetadata.version_code,[ref]$recordedCode) -or
        $recordedCode -lt 1 -or $recordedCode -gt 2100000000) { throw 'latest.json 的包名或版本记录无效，已停止更新。' }
    if ($recordedCode -gt $latestCode) { $latestCode = $recordedCode }
  }
  if ($incoming.VersionCode -lt $latestCode) {
    return [pscustomobject]@{ Published = $false; Reason = 'older_version'; VersionCode = $incoming.VersionCode; LatestVersionCode = $latestCode; ApkPath = $sourcePath; LatestApkPath = $latestPath; MetadataPath = $metadataPath }
  }

  $sha = (Get-FileHash -LiteralPath $firstStage -Algorithm SHA256).Hash.ToLowerInvariant()
  Copy-Snapshot $firstStage $secondStage
  if ((Get-FileHash -LiteralPath $secondStage -Algorithm SHA256).Hash.ToLowerInvariant() -cne $sha) { throw 'APK 暂存副本校验失败，已停止更新。' }
  $metadata = [ordered]@{
    schema_version = 1
    package_name = $incoming.Package
    version_code = $incoming.VersionCode
    version_name = $incoming.VersionName
    sha256 = $sha
    size_bytes = (Get-Item -LiteralPath $firstStage).Length
    source_filename = [IO.Path]::GetFileName($sourcePath)
    published_at = [DateTimeOffset]::UtcNow.ToString('o')
    aliases = @('tada-latest.apk','tomorrow-ai-latest.apk')
  }
  Assert-OutputFile $metadataStage
  [IO.File]::WriteAllText($metadataStage, (($metadata | ConvertTo-Json -Depth 4) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  # Each replacement is atomic on this filesystem. The folder lock serializes
  # writers; metadata commits last, and any failed replacement restores aliases.
  Replace-PublishedFile $firstStage $latestPath ($prefix + '-tada.backup')
  Replace-PublishedFile $secondStage $legacyPath ($prefix + '-legacy.backup')
  Replace-PublishedFile $metadataStage $metadataPath ($prefix + '-metadata.backup')
  $published = $true
  return [pscustomobject]@{ Published = $true; Reason = 'published'; VersionCode = $incoming.VersionCode; LatestVersionCode = $incoming.VersionCode; VersionName = $incoming.VersionName; Sha256 = $sha; ApkPath = $sourcePath; LatestApkPath = $latestPath; MetadataPath = $metadataPath }
} catch {
  $failure = $_
  if (-not $published -and $script:replaced.Count -gt 0) {
    for ($index = $script:replaced.Count - 1; $index -ge 0; $index--) {
      $item = $script:replaced[$index]
      try {
        if ($item.Existed) {
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
      if (-not ($keepBackups -and $temporary.EndsWith('.backup',[StringComparison]::OrdinalIgnoreCase)) -and [IO.File]::Exists($temporary)) {
        try { [IO.File]::Delete($temporary) }
        catch { Write-Warning '发布临时文件暂时无法清理，可稍后删除输出目录中的 .apk-publish 临时文件。' }
      }
    }
  } finally {
    if ($lock) { $lock.Dispose() }
  }
}
