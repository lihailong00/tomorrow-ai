param(
  [string]$JavaHome = 'D:/Program Files/Android/Android Studio/jbr',
  [string]$AndroidHome = 'D:/Android/Sdk',
  [string]$OutputDirectory = 'artifacts/release42-20261102/vault/native-check'
)
$ErrorActionPreference = 'Stop'
$vaultRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$vaultCache = Join-Path $env:USERPROFILE '.gradle/caches'
function Find-VaultJar([string]$Relative, [string]$Name) {
  $jar = Get-ChildItem -LiteralPath (Join-Path $vaultCache ('modules-2/files-2.1/' + $Relative)) -Filter $Name -Recurse -File | Select-Object -First 1
  if (-not $jar) { throw ('Existing shared dependency missing: ' + $Relative + '/' + $Name) }
  return $jar.FullName
}
$compiler = Find-VaultJar 'org.jetbrains.kotlin/kotlin-compiler-embeddable/2.1.20' 'kotlin-compiler-embeddable-2.1.20.jar'
$stdlib = Find-VaultJar 'org.jetbrains.kotlin/kotlin-stdlib/2.1.20' 'kotlin-stdlib-2.1.20.jar'
$script = Find-VaultJar 'org.jetbrains.kotlin/kotlin-script-runtime/2.1.20' 'kotlin-script-runtime-2.1.20.jar'
$daemon = Find-VaultJar 'org.jetbrains.kotlin/kotlin-daemon-embeddable/2.1.20' 'kotlin-daemon-embeddable-2.1.20.jar'
$trove = Find-VaultJar 'org.jetbrains.intellij.deps/trove4j/1.0.20200330' 'trove4j-1.0.20200330.jar'
$coroutines = Find-VaultJar 'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm/1.9.0' 'kotlinx-coroutines-core-jvm-1.9.0.jar'
$annotations = Find-VaultJar 'org.jetbrains/annotations/23.0.0' 'annotations-23.0.0.jar'
$junit = Find-VaultJar 'junit/junit/4.13.2' 'junit-4.13.2.jar'
$hamcrest = Find-VaultJar 'org.hamcrest/hamcrest-core/1.3' 'hamcrest-core-1.3.jar'
$react = Get-ChildItem -LiteralPath (Join-Path $vaultCache '9.0.0/transforms') -Filter 'react-android-0.82.1-release-api.jar' -File -Recurse | Select-Object -First 1
if (-not $react) { throw 'The existing React Native Android API jar was not found; this check never downloads dependencies.' }
$vaultOut = [IO.Path]::GetFullPath((Join-Path $vaultRoot $OutputDirectory))
$vaultArtifactRoot = [IO.Path]::GetFullPath((Join-Path $vaultRoot 'artifacts'))
if (-not $vaultOut.StartsWith($vaultArtifactRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'OutputDirectory must stay inside this project artifacts directory.'
}
New-Item -ItemType Directory -Force -Path $vaultOut | Out-Null
$vaultJar = Join-Path $vaultOut 'vault-check.jar'
$compilerClassPath = @($compiler, $stdlib, $script, $daemon, $trove, $coroutines, $annotations) -join [IO.Path]::PathSeparator
$sourceClassPath = @($stdlib, (Join-Path $AndroidHome 'platforms/android-36/android.jar'), $react.FullName, $junit, $annotations) -join [IO.Path]::PathSeparator
$vaultSources = @(
  (Join-Path $vaultRoot 'apps/mobile/android/app/src/main/java/com/tomorrowai/VaultCrypto.kt'),
  (Join-Path $vaultRoot 'apps/mobile/android/app/src/main/java/com/tomorrowai/PrivateVaultModule.kt'),
  (Join-Path $vaultRoot 'apps/mobile/android/app/src/test/java/com/tomorrowai/VaultCryptoTest.kt')
)
& (Join-Path $JavaHome 'bin/java.exe') '-Xmx512m' '-cp' $compilerClassPath 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler' '-no-stdlib' '-no-reflect' '-jvm-target' '17' '-classpath' $sourceClassPath '-d' $vaultJar @vaultSources
if ($LASTEXITCODE -ne 0) { throw 'Vault native source compilation failed.' }
& (Join-Path $JavaHome 'bin/java.exe') '-cp' (@($vaultJar, $stdlib, $junit, $hamcrest) -join [IO.Path]::PathSeparator) 'org.junit.runner.JUnitCore' 'com.tomorrowai.VaultCryptoTest'
if ($LASTEXITCODE -ne 0) { throw 'Vault cryptography tests failed.' }
Write-Host ('Native module compiled; cryptography tests passed. Output bytes: ' + (Get-Item -LiteralPath $vaultJar).Length)
