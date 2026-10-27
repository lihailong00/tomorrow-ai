[CmdletBinding()]
param(
    [string]$DockerContext = 'desktop-linux',
    [string]$OutputDirectory = 'artifacts/deploy/linux-x64',
    [string]$BuildProxy = '',
    [switch]$ApiOnly
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot 'artifacts/deploy'))
if (-not $outputPath.StartsWith($allowedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDirectory must be a child of this repository artifacts/deploy directory.'
}
# Fail closed on old artifacts. This script never removes an existing package.
if ((Test-Path -LiteralPath $outputPath) -and (Get-ChildItem -LiteralPath $outputPath -Force | Select-Object -First 1)) {
    throw 'The output directory is not empty. Choose a fresh OutputDirectory.'
}
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$buildContext = Join-Path $outputPath 'source-context'
New-Item -ItemType Directory -Path $buildContext -Force | Out-Null
# Older Docker clients do not consistently honor a Dockerfile-specific ignore
# file. Copy an explicit source-only context before invoking Docker as a second,
# independent boundary: the repository root is never the Docker build context.
foreach ($relative in @('Cargo.toml','Cargo.lock')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $relative) -Destination (Join-Path $buildContext $relative)
}
foreach ($crate in @('api','attachments','connectors','domain','worker')) {
    $crateRoot = Join-Path $buildContext "crates/$crate"
    New-Item -ItemType Directory -Path $crateRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $projectRoot "crates/$crate/Cargo.toml") -Destination (Join-Path $crateRoot 'Cargo.toml')
    Copy-Item -LiteralPath (Join-Path $projectRoot "crates/$crate/src") -Destination (Join-Path $crateRoot 'src') -Recurse
}
Copy-Item -LiteralPath (Join-Path $projectRoot 'migrations') -Destination (Join-Path $buildContext 'migrations') -Recurse
$agentContext = Join-Path $buildContext 'services/agent'
New-Item -ItemType Directory -Path $agentContext -Force | Out-Null
foreach ($relative in @('package.json','pnpm-lock.yaml','tsconfig.json','src')) {
    Copy-Item -LiteralPath (Join-Path $projectRoot "services/agent/$relative") -Destination (Join-Path $agentContext $relative) -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $buildContext 'infra') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'infra/deploy') -Destination (Join-Path $buildContext 'infra/deploy') -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'infra/deploy/backend.Dockerfile.dockerignore') -Destination (Join-Path $buildContext '.dockerignore')
$dockerFile = Join-Path $buildContext 'infra/deploy/backend.Dockerfile'
$archiveName = if ($ApiOnly) { 'tomorrow-api-linux-x64.tar' } else { 'tomorrow-backend-linux-x64.tar' }
$buildTarget = if ($ApiOnly) { 'api-package' } else { 'package' }
$archivePath = Join-Path $outputPath $archiveName
$buildArguments = @('--context', $DockerContext, 'build', '--platform', 'linux/amd64', '--file', $dockerFile, '--target', $buildTarget, '--output', "type=tar,dest=$archivePath")
if ($ApiOnly) { $buildArguments += @('--build-arg', 'BUILD_API_ONLY=1') }
if ($BuildProxy) {
    $proxyUri = [uri]$BuildProxy
    if ($proxyUri.Scheme -notin @('http','https') -or $proxyUri.UserInfo) {
        throw 'BuildProxy must be an HTTP(S) URL without credentials.'
    }
    $buildArguments += @('--build-arg', "HTTP_PROXY=$BuildProxy", '--build-arg', "HTTPS_PROXY=$BuildProxy")
}
$buildArguments += $buildContext
& docker @buildArguments
if ($LASTEXITCODE -ne 0) { throw 'Linux package build failed.' }
$members = & tar -tf $archivePath
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the exported Linux tar package.' }
$expectedFiles = if ($ApiOnly) { @('bin/tomorrow-api') } else { @('bin/tomorrow-api','bin/tomorrow-worker','bin/node','services/agent/dist/server.js') }
foreach ($relative in $expectedFiles) {
    if ($members -notcontains $relative) { throw "Build did not export $relative" }
}
if ($ApiOnly -and @($members | Where-Object { $_ -notmatch '^(?:\./)?(?:bin/?|bin/tomorrow-api)$' }).Count -gt 0) {
    throw 'The API-only archive contains an unexpected entry.'
}
$compressedPath = $archivePath + '.gz'
$inputStream = [IO.File]::OpenRead($archivePath)
$compressedFile = [IO.File]::Create($compressedPath)
$gzipStream = [IO.Compression.GZipStream]::new($compressedFile, [IO.Compression.CompressionLevel]::Optimal)
try { $inputStream.CopyTo($gzipStream) }
finally { $gzipStream.Dispose(); $compressedFile.Dispose(); $inputStream.Dispose() }
$hash = (Get-FileHash -LiteralPath $compressedPath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $outputPath 'SHA256SUMS'), "$hash  $archiveName.gz`n", [Text.UTF8Encoding]::new($false))
Write-Host "Linux package ready: $compressedPath"
Write-Host 'This package has no model key, database password, phone/SMS production configuration or TLS certificate.'
