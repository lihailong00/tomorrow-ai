[CmdletBinding()]
param(
  [string]$NodePath,
  [string]$JavaHome,
  [string]$AndroidHome,
  [string]$ProxyUrl,
  [string]$NativeBuildDirectory,
  [string]$Architectures = 'arm64-v8a,x86_64',
  [switch]$DetailedLogs,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$mobilePath = Join-Path $repoPath 'apps/mobile'
$previousLocation = Get-Location
$previousEnvironment = @{}
foreach ($name in @('Path','JAVA_HOME','ANDROID_HOME','ANDROID_SDK_ROOT')) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function First-ExistingFile([string[]]$Candidates) {
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) { return (Resolve-Path -LiteralPath $candidate).Path }
  }
  return $null
}

try {
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
  $gradleArgs = @(':app:assembleDebug','-PofflineBundle=true',('-PreactNativeArchitectures=' + $Architectures),'--console=plain','--max-workers=4')
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

  $artifactPath = Join-Path $repoPath 'artifacts/apk'
  New-Item -ItemType Directory -Path $artifactPath -Force | Out-Null
  $packageVersion = [string](Get-Content -LiteralPath (Join-Path $mobilePath 'package.json') -Raw | ConvertFrom-Json).version
  if ($packageVersion -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw 'package.json 中的版本号无效，无法生成安装包文件名。'
  }
  $buildStamp = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyyMMdd-HHmmss-fff')
  $apkPath = Join-Path $artifactPath "tada-v$packageVersion-$buildStamp.apk"
  Copy-Item -LiteralPath (Join-Path $mobilePath 'android/app/build/outputs/apk/debug/app-debug.apk') -Destination $apkPath -Force
  $latestApkPath = Join-Path $artifactPath 'tada-latest.apk'
  Copy-Item -LiteralPath $apkPath -Destination $latestApkPath -Force
  # Preserve the existing fixed download path after the product rename.
  Copy-Item -LiteralPath $apkPath -Destination (Join-Path $artifactPath 'tomorrow-ai-latest.apk') -Force
  Write-Output ('测试安装包已生成：' + $apkPath)
  Write-Output ('最新版固定入口：' + $latestApkPath)
} finally {
  Set-Location -LiteralPath $previousLocation
  foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
}
