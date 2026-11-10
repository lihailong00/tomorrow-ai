$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Android-PackageTargets.ps1')
. (Join-Path $PSScriptRoot 'Project-Storage.ps1')
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Assert-Equal($Actual, $Expected) {
  if ($Actual -ne $Expected) { throw "Expected '$Expected', got '$Actual'." }
}
function Assert-Rejected([scriptblock]$Action, [string]$Message) {
  $rejected = $false
  try { & $Action | Out-Null } catch {
    if ($_.Exception.Message -notlike ('*' + $Message + '*')) { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw 'Expected invalid APK/target to be rejected.' }
}

$phone = Get-TadaAndroidPackageTarget
$emulator = Get-TadaAndroidPackageTarget -Target Emulator
Assert-Equal $phone.Architecture 'arm64-v8a'
Assert-Equal $phone.ArtifactDirectory 'artifacts/apk'
Assert-Equal $emulator.Architecture 'x86_64'
Assert-Equal $emulator.ArtifactDirectory 'artifacts/apk/emulator'
Assert-Equal (Get-TadaAndroidPackageTarget -Architectures x86_64).Name 'Emulator'
Assert-Equal (Get-TadaAndroidPackageTarget -Architectures arm64-v8a).Name 'Phone'
Assert-Rejected { Get-TadaAndroidPackageTarget -Target Phone -Architectures x86_64 } 'does not match'
Assert-Rejected { Get-TadaAndroidPackageTarget -Architectures 'arm64-v8a,x86_64' } 'one architecture'
Assert-Rejected { Get-TadaAndroidPackageTarget -Architectures armeabi-v7a } 'one architecture'
if ($phone.StorageReport -eq $emulator.StorageReport) { throw 'Targets must keep independent reports.' }
$standard = Get-TadaAndroidBuildPlan -PackageTarget $phone
Assert-Equal $standard.GradleTask ':app:assembleDebug'
Assert-Equal $standard.ArtifactDirectory 'artifacts/apk/candidates/debug'
Assert-Equal $standard.Candidate $true
Assert-Equal (Get-TadaAndroidBuildPlan -PackageTarget $phone -BuildType Release).ArtifactDirectory 'artifacts/apk'
$release = Get-TadaAndroidBuildPlan -PackageTarget $phone -BuildType Release -Candidate
$compact = Get-TadaAndroidBuildPlan -PackageTarget $phone -BuildType Release -Compact -Candidate
Assert-Equal $release.GradleTask ':app:assembleRelease'
Assert-Equal $compact.NativeTestTask ':app:testReleaseUnitTest'
Assert-Equal $compact.BuiltApk 'android/app/build/outputs/apk/release/app-release.apk'
Assert-Equal $compact.ArtifactDirectory 'artifacts/apk/candidates/release-compact'
Assert-Equal $compact.Candidate $true
Assert-Equal (Get-TadaAndroidBuildPlan -PackageTarget $emulator -BuildType Release -Compact -Candidate).ArtifactDirectory 'artifacts/apk/emulator/candidates/release-compact'
if ($release.ArtifactDirectory -eq $compact.ArtifactDirectory -or $compact.StorageReport -eq $phone.StorageReport) {
  throw 'Candidates must keep independent output and storage reports.'
}
Assert-Rejected { Get-TadaAndroidBuildPlan -PackageTarget $phone -Compact } 'requires a Release'

# Only tiny synthetic ZIPs are created; existing APKs and build outputs are untouched.
$fixtureParent = Get-TadaFullPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts/android-package-target-tests')
$fixtureRoot = Join-Path $fixtureParent ([Guid]::NewGuid().ToString('N'))
Assert-TadaPlainPath $fixtureRoot
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
function New-ApkFixture([string]$Name, [string[]]$Entries) {
  $path = Join-Path $fixtureRoot ($Name + '.apk')
  $zip = [IO.Compression.ZipFile]::Open($path, [IO.Compression.ZipArchiveMode]::Create)
  try { foreach ($entry in $Entries) { [void]$zip.CreateEntry($entry) } }
  finally { $zip.Dispose() }
  return $path
}
try {
  $phoneApk = New-ApkFixture 'phone' @('classes.dex', 'lib/arm64-v8a/libreactnative.so')
  $emulatorApk = New-ApkFixture 'emulator' @('classes.dex', 'lib/x86_64/libreactnative.so')
  Assert-Equal (Assert-TadaAndroidPackageContents $phoneApk arm64-v8a).Architecture 'arm64-v8a'
  Assert-Equal (Assert-TadaAndroidPackageContents $emulatorApk x86_64).Architecture 'x86_64'
  Assert-Rejected { Assert-TadaAndroidPackageContents $emulatorApk arm64-v8a } 'must contain only'
  $mixed = New-ApkFixture 'mixed' @('lib/arm64-v8a/libreactnative.so', 'lib/x86_64/libreactnative.so')
  Assert-Rejected { Assert-TadaAndroidPackageContents $mixed arm64-v8a } 'must contain only'
  $empty = New-ApkFixture 'empty' @('classes.dex')
  Assert-Rejected { Assert-TadaAndroidPackageContents $empty arm64-v8a } 'must contain only'
  $ocrLib = New-ApkFixture 'ocr-native' @('lib/arm64-v8a/libmlkit_google_ocr_pipeline.so')
  Assert-Rejected { Assert-TadaAndroidPackageContents $ocrLib arm64-v8a } 'Bundled OCR remains'
  $ocrAssets = New-ApkFixture 'ocr-assets' @('lib/arm64-v8a/libreactnative.so', 'assets/mlkit-google-ocr-models/model.bin')
  Assert-Rejected { Assert-TadaAndroidPackageContents $ocrAssets arm64-v8a } 'Bundled OCR remains'
  Write-Output 'PASS: separate phone/emulator targets, architecture guards and bundled OCR rejection.'
} finally {
  # The GUID fixture is owned by this invocation and stays inside the test root.
  if (-not (Test-TadaPathInside $fixtureRoot $fixtureParent) -or $fixtureRoot -eq $fixtureParent) {
    throw 'Unsafe fixture cleanup path.'
  }
  Assert-TadaPlainPath $fixtureRoot
  Remove-Item -LiteralPath $fixtureRoot -Recurse -Force
}
