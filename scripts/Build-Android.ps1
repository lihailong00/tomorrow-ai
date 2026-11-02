[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$JavaHome,
  [string]$AndroidHome,
  [string]$ProxyUrl,
  [string]$NativeBuildDirectory,
  [ValidateSet('Phone','Emulator')][string]$Target,
  [string]$Architectures,
  [ValidateSet('Debug','Release')][string]$BuildType = 'Debug',
  [switch]$Compact,
  [switch]$Candidate,
  [switch]$RunNativeTests,
  [switch]$PreserveRustTarget,
  [ValidateRange(0,100000000000)][long]$EstimatedBuildBytes = 2000000000,
  [switch]$DetailedLogs,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$mobilePath = Join-Path $repoPath 'apps/mobile'
$previousLocation = Get-Location
$previousEnvironment = @{}
foreach ($name in @('Path','JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT','CARGO_TARGET_DIR','GRADLE_USER_HOME')) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
. (Join-Path $PSScriptRoot 'Project-Storage.ps1')
. (Join-Path $PSScriptRoot 'Android-PackageTargets.ps1')
$packageTarget = Get-TadaAndroidPackageTarget -Target $Target -Architectures $Architectures
$buildPlan = Get-TadaAndroidBuildPlan -PackageTarget $packageTarget -BuildType $BuildType -Compact:$Compact -Candidate:$Candidate
$Architectures = $packageTarget.Architecture
if ($NativeBuildDirectory) { $NativeBuildDirectory = Get-TadaFullPath $NativeBuildDirectory }
$packagingLease = $null
$storageBefore = $null
$storageReady = $null
$preCleanup = $null
$buildSucceeded = $false
$publication = $null
$packageContents = $null
$apkPath = $null
$mappingPath = $null
$nativeTestSummary = $null
$storagePaths = @($NativeBuildDirectory, $env:CARGO_TARGET_DIR, $env:GRADLE_USER_HOME) | Where-Object { $_ } | ForEach-Object { Get-TadaFullPath $_ }

function First-ExistingFile([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

try {
  # One writer across linked worktrees; acquire before installs or cache cleanup.
  $packagingLease = Enter-TadaPackagingLease -RepoPath $repoPath
  foreach ($name in @('CARGO_TARGET_DIR','GRADLE_USER_HOME')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($value) { [Environment]::SetEnvironmentVariable($name, (Get-TadaFullPath $value), 'Process') }
  }
  Register-TadaStoragePaths -RepoPath $repoPath -AdditionalPaths $storagePaths -Lease $packagingLease
  if ($NativeBuildDirectory) { Initialize-TadaNativeBuildDirectory -RepoPath $repoPath -NativeBuildDirectory $NativeBuildDirectory }
  $storageBefore = Get-TadaStorageUsage -RepoPath $repoPath -AdditionalPaths $storagePaths
  # 10 GB is a retained target after housekeeping, not a transient build cap.
  # Keep warm caches for build speed; reclaim unused outputs only in finally.
  $storageReady = $storageBefore
  Write-Host ('Storage before build: {0:N2} GB measured ({1}); retained target after housekeeping: 10 GB. Temporary build usage may exceed the target.' -f ($storageBefore.TotalBytes / 1e9), $storageBefore.Status)
  if ($storageBefore.Status -eq 'incomplete') { Write-Warning 'Some project paths could not be measured; see the final storage report for accounting limits.' }
  Write-Verbose ('Estimated transient peak: {0:N2} GB; no pre-build cache cleanup or retained-target enforcement.' -f (($storageBefore.TotalBytes + $EstimatedBuildBytes) / 1e9))
  # Enforce actual available disk space, not the retained-storage target.
  foreach ($driveRoot in (@($repoPath) + $storagePaths | ForEach-Object { [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($_)) } | Select-Object -Unique)) {
    $buildDrive = [IO.DriveInfo]::new($driveRoot)
    if ($EstimatedBuildBytes -gt 0 -and $buildDrive.AvailableFreeSpace -lt $EstimatedBuildBytes) {
      throw ('Insufficient free space for the estimated Android build on ' + $driveRoot + '; current latest and rollback were preserved.')
    }
  }
  if (-not $NodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    $NodePath = First-ExistingFile @(
      $nodeCommand.Source,
      (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'),
      (Join-Path $env:ProgramFiles 'nodejs/node.exe')
    )
  }
  if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw 'Node.js 未找到。安装 Node 20.19.4+，或传入 -NodePath。'
  }

  if (-not $JavaHome) {
    $javaCandidates = [System.Collections.Generic.List[string]]::new()
    if ($env:JAVA_HOME) { $javaCandidates.Add($env:JAVA_HOME) }
    foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
      foreach ($base in @('Program Files/JetBrains','Program Files/Android','Program Files/Java','Program Files/Eclipse Adoptium')) {
        $basePath = Join-Path $drive.Root $base
        if (Test-Path -LiteralPath $basePath) {
          foreach ($child in Get-ChildItem -LiteralPath $basePath -Directory) {
            $javaCandidates.Add($child.FullName)
            $javaCandidates.Add((Join-Path $child.FullName 'jbr'))
          }
        }
      }
    }
    # Prefer JDK 17. JDK 21 also runs this Gradle/AGP toolchain.
    foreach ($major in @(17,21)) {
      foreach ($candidate in $javaCandidates) {
        $releasePath = Join-Path $candidate 'release'
        if ((Test-Path -LiteralPath $releasePath) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'bin/java.exe')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'bin/jlink.exe')) -and
            (Test-Path -LiteralPath (Join-Path $candidate 'bin/javac.exe'))) {
          $release = Get-Content -LiteralPath $releasePath -Raw
          if ($release -match ('JAVA_VERSION="' + $major + '\.')) { $JavaHome = $candidate; break }
        }
      }
      if ($JavaHome) { break }
    }
  }
  if (-not $JavaHome -or -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/jlink.exe')) -or
      -not (Test-Path -LiteralPath (Join-Path $JavaHome 'bin/javac.exe'))) {
    throw '完整 JDK 未找到（需要 java、javac、jlink）。安装 JDK 17/21，或传入 -JavaHome。'
  }

  if (-not $AndroidHome) {
    $sdkCandidates = [System.Collections.Generic.List[string]]::new()
    foreach ($candidate in @($env:ANDROID_HOME,$env:ANDROID_SDK_ROOT,(Join-Path $env:LOCALAPPDATA 'Android/Sdk'))) {
      if ($candidate) { $sdkCandidates.Add($candidate) }
    }
    foreach ($drive in Get-PSDrive -PSProvider FileSystem) { $sdkCandidates.Add((Join-Path $drive.Root 'Android/Sdk')) }
    foreach ($candidate in $sdkCandidates) {
      if ((Test-Path -LiteralPath (Join-Path $candidate 'platforms/android-36/android.jar')) -and
          (Test-Path -LiteralPath (Join-Path $candidate 'ndk/27.2.12479018/source.properties'))) {
        $AndroidHome = $candidate; break
      }
    }
  }
  if (-not $AndroidHome -or -not (Test-Path -LiteralPath $AndroidHome -PathType Container)) {
    throw 'Android SDK 未找到。需要 Platform 36、Build Tools 36.0.0、NDK 27.2.12479018、CMake 3.22.1；可传入 -AndroidHome。'
  }

  $env:JAVA_HOME = $JavaHome
  $env:ANDROID_HOME = $AndroidHome
  $env:ANDROID_SDK_ROOT = $AndroidHome
  $env:Path = (Split-Path -Parent $NodePath) + ';' + (Join-Path $JavaHome 'bin') + ';' + $env:Path
  Set-Location -LiteralPath $mobilePath
  if (-not $SkipInstall) {
    $pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCommand) {
      & $pnpmCommand.Source install --frozen-lockfile --node-linker=hoisted
    } else {
      $pnpmRuntime = Join-Path (Split-Path -Parent (Split-Path -Parent $NodePath)) 'node_modules/pnpm/bin/pnpm.mjs'
      if (-not (Test-Path -LiteralPath $pnpmRuntime)) { throw 'pnpm 未找到。先安装 pnpm；已有依赖可传入 -SkipInstall。' }
      & $NodePath $pnpmRuntime install --frozen-lockfile --node-linker=hoisted
    }
    if ($LASTEXITCODE -ne 0) { throw '手机端依赖安装失败。' }
  }
  & $NodePath 'node_modules/typescript/bin/tsc' --noEmit
  if ($LASTEXITCODE -ne 0) { throw '手机端类型检查未通过。' }

  $sdkProperty = 'sdk.dir=' + $AndroidHome.Replace('\','/') + [Environment]::NewLine
  [System.IO.File]::WriteAllText((Join-Path $mobilePath 'android/local.properties'), $sdkProperty, [System.Text.UTF8Encoding]::new($false))
  $gradleArgs = @($buildPlan.GradleTask,'-PofflineBundle=true',('-PreactNativeArchitectures=' + $Architectures),('-PtadaCompactApk=' + $Compact.IsPresent.ToString().ToLowerInvariant()),'-Pkotlin.compiler.execution.strategy=in-process','--console=plain','--max-workers=4','--no-daemon')
  if ($RunNativeTests) { $gradleArgs = @($buildPlan.NativeTestTask) + $gradleArgs }
  if ($NativeBuildDirectory) {
    $nativePath = [IO.Path]::GetFullPath($NativeBuildDirectory).Replace('\','/')
    $gradleArgs += "-PtadaNativeBuildDir=$nativePath"
  }
  if ($DetailedLogs) { $gradleArgs += '--info' }
  if (-not $ProxyUrl) { $ProxyUrl = $env:HTTPS_PROXY }
  if (-not $ProxyUrl) { $ProxyUrl = $env:HTTP_PROXY }
  if ($ProxyUrl) {
    $proxy = [uri]$ProxyUrl
    if ($proxy.UserInfo) { throw '构建代理包含凭据。请使用本地无认证代理，避免凭据进入命令行。' }
    if ($proxy.Scheme -notin @('http','https')) { throw 'Gradle 构建代理需为 HTTP/HTTPS 地址。' }
    foreach ($scheme in @('http','https')) {
      $gradleArgs += '-D' + $scheme + '.proxyHost=' + $proxy.Host
      $gradleArgs += '-D' + $scheme + '.proxyPort=' + $proxy.Port
    }
    # The wrapper downloads before Gradle reads CLI properties.
    $oldJavaOpts = $env:JAVA_OPTS
    $env:JAVA_OPTS = "$oldJavaOpts -Dhttps.proxyHost=$($proxy.Host) -Dhttps.proxyPort=$($proxy.Port) -Dhttp.proxyHost=$($proxy.Host) -Dhttp.proxyPort=$($proxy.Port)"
  }
  try {
    Set-Location -LiteralPath (Join-Path $mobilePath 'android')
    & '.\gradlew.bat' @gradleArgs
    if ($LASTEXITCODE -ne 0) { throw 'Android 构建失败，请查看上方诊断。' }
  } finally {
    if ($ProxyUrl) { $env:JAVA_OPTS = $oldJavaOpts }
  }

  $artifactPath = Join-Path $repoPath $buildPlan.ArtifactDirectory
  Assert-TadaPlainPath $artifactPath
  New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
  $packageVersion = [string](Get-Content -LiteralPath (Join-Path $mobilePath 'package.json') -Raw | ConvertFrom-Json).version
  if ($packageVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'package.json 中的版本号无效，无法生成安装包文件名。'
  }
  $buildStamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss-fff')
  $apkPath = Join-Path $artifactPath "tada-v$packageVersion-$buildStamp.apk"
  $builtApkPath = Join-Path $mobilePath $buildPlan.BuiltApk
  Assert-TadaPlainPath $builtApkPath
  Assert-TadaPlainPath $apkPath
  $packageContents = Assert-TadaAndroidPackageContents -ApkPath $builtApkPath -Architecture $packageTarget.Architecture -RequireReleaseInterop:($BuildType -eq 'Release')
  Copy-Item -LiteralPath $builtApkPath -Destination $apkPath -Force
  if ($BuildType -eq 'Release') {
    # Preserve crash deobfuscation data before automatic cache housekeeping.
    $mappingSource = Join-Path $mobilePath 'android/app/build/outputs/mapping/release/mapping.txt'
    Assert-TadaPlainPath $mappingSource
    $mappingPath = $apkPath + '.mapping.txt.gz'
    Assert-TadaPlainPath $mappingPath
    $mappingInput = [IO.File]::OpenRead($mappingSource)
    try {
      $mappingOutput = [IO.File]::Create($mappingPath)
      try {
        $mappingGzip = [IO.Compression.GZipStream]::new($mappingOutput, [IO.Compression.CompressionMode]::Compress, $true)
        try { $mappingInput.CopyTo($mappingGzip) } finally { $mappingGzip.Dispose() }
      } finally { $mappingOutput.Dispose() }
    } finally { $mappingInput.Dispose() }
  }
  if ($RunNativeTests) {
    $nativeResultsPath = Join-Path $mobilePath ('android/app/build/test-results/test' + $BuildType + 'UnitTest')
    $nativeSuites = @(Get-ChildItem -LiteralPath $nativeResultsPath -Filter 'TEST-*.xml' -File | ForEach-Object {
      [xml]$testResult = Get-Content -LiteralPath $_.FullName -Raw
      [pscustomobject]@{ name=$testResult.testsuite.name; tests=[int]$testResult.testsuite.tests; failures=[int]$testResult.testsuite.failures; errors=[int]$testResult.testsuite.errors; skipped=[int]$testResult.testsuite.skipped }
    })
    $nativeTestSummary = [pscustomobject]@{ suites=$nativeSuites; tests=($nativeSuites | Measure-Object tests -Sum).Sum; failures=($nativeSuites | Measure-Object failures -Sum).Sum; errors=($nativeSuites | Measure-Object errors -Sum).Sum }
  }
  if (-not $Candidate) {
    $publication = & (Join-Path $PSScriptRoot 'Publish-AndroidApk.ps1') -ApkPath $apkPath -OutputDirectory $artifactPath -AndroidHome $AndroidHome
  }
  $buildSucceeded = $true
  Write-Output ('测试安装包已生成（' + $packageTarget.Name + ' / ' + $packageTarget.Architecture + '）：' + $apkPath)
  if ($Candidate) {
    Write-Output ('候选包已保留，latest 未替换：' + $apkPath)
  } elseif ($publication.Published) {
    Write-Output ('最新版固定入口：' + $publication.LatestApkPath)
  } else {
    Write-Output ('此安装包的 versionCode ' + $publication.VersionCode + ' 低于已发布的 ' + $publication.LatestVersionCode + '，已保留带日期的安装包，未替换最新版。')
  }
} finally {
  if ($packagingLease) {
    try {
      $phase = if ($buildSucceeded) { 'Success' } else { 'Failure' }
      $postCleanup = Invoke-TadaBuildCacheCleanup -RepoPath $repoPath -Lease $packagingLease -Phase $phase -NativeBuildDirectory $NativeBuildDirectory
      Write-TadaCleanupStatus $postCleanup
      $storageAfter = Get-TadaStorageUsage -RepoPath $repoPath -AdditionalPaths $storagePaths
      if ($storageAfter.TotalBytes -ge $storageAfter.WarningBytes -and -not $PreserveRustTarget) {
        $rustCleanup = Invoke-TadaBuildCacheCleanup -RepoPath $repoPath -Lease $packagingLease -Phase $phase -IncludeRustTarget
        Write-TadaCleanupStatus $rustCleanup
        $storageAfter = Get-TadaStorageUsage -RepoPath $repoPath -AdditionalPaths $storagePaths
      } else { $rustCleanup = $null }
      Write-TadaStorageStatus -Usage $storageAfter -Phase 'after housekeeping'
      $report = [ordered]@{
        schema_version=1; finished_at=[DateTimeOffset]::UtcNow.ToString('o'); build_succeeded=$buildSucceeded
        package_target=$packageTarget.Name; build_type=$BuildType; compact=[bool]$Compact; candidate=[bool]$Candidate; apk_path=$apkPath; mapping_path=$mappingPath; native_tests=$nativeTestSummary; package_contents=$packageContents; rust_target_preserved=[bool]$PreserveRustTarget
        budget_bytes=10000000000; warning_bytes=9000000000; estimated_build_bytes=$EstimatedBuildBytes
        budget_scope='retained_after_housekeeping'; temporary_overage_allowed=$true; pre_cleanup_policy='deferred_until_build_finishes'
        actual_peak_bytes=$null; peak_note='Pre/post measurements only; temporary build peak is not continuously monitored.'
        before=$storageBefore; ready=$storageReady; after=$storageAfter
        pre_cleanup=$preCleanup; post_cleanup=$postCleanup; rust_cleanup=$rustCleanup; publication=$publication
      }
      $reportDirectory = Join-Path $repoPath 'artifacts'
      Assert-TadaPlainPath $reportDirectory
      New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null
      $reportPath = Join-Path $reportDirectory $buildPlan.StorageReport
      Assert-TadaPlainPath $reportPath
      [IO.File]::WriteAllText($reportPath, (($report | ConvertTo-Json -Depth 12) + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
      Write-Host ('Storage report: ' + $reportPath)
      if ($storageAfter.TotalBytes -gt $storageAfter.BudgetBytes) { Write-Warning 'Safe cleanup finished, but retained project storage remains above the 10 GB target. Required data and unrelated work were preserved; temporary build usage was allowed.' }
    } catch { Write-Warning ('Storage housekeeping/report could not finish: ' + $_.Exception.Message) }
    finally { $packagingLease.Stream.Dispose() }
  }
  Set-Location -LiteralPath $previousLocation
  foreach ($name in $previousEnvironment.Keys) {
    if ($null -eq $previousEnvironment[$name]) { Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
  }
}
