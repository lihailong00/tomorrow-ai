# Pure target selection and read-only APK validation; safe to dot-source.
function Get-TadaAndroidPackageTarget {
  param([string]$Target, [string]$Architectures)
  $architecture = $Architectures.Trim()
  if ($architecture -and $architecture -notin @('arm64-v8a', 'x86_64')) {
    throw 'Build one architecture at a time: arm64-v8a (Phone) or x86_64 (Emulator).'
  }
  if (-not $Target) {
    $Target = if ($architecture -eq 'x86_64') { 'Emulator' } else { 'Phone' }
  }
  if ($Target -notin @('Phone', 'Emulator')) { throw 'Unknown Android package target.' }
  $expected = if ($Target -eq 'Phone') { 'arm64-v8a' } else { 'x86_64' }
  if ($architecture -and $architecture -ne $expected) {
    throw ('Architecture ' + $architecture + ' does not match target ' + $Target + '.')
  }
  [pscustomobject]@{
    Name = $Target
    Architecture = $expected
    ArtifactDirectory = $(if ($Target -eq 'Phone') { 'artifacts/apk' } else { 'artifacts/apk/emulator' })
    StorageReport = $(if ($Target -eq 'Phone') { 'packaging-storage.json' } else { 'packaging-storage-emulator.json' })
  }
}

function Get-TadaAndroidBuildPlan {
  param(
    [Parameter(Mandatory)]$PackageTarget,
    [ValidateSet('Debug','Release')][string]$BuildType = 'Debug',
    [switch]$Compact,
    [switch]$Candidate
  )
  if ($Compact -and $BuildType -ne 'Release') { throw 'Compact packaging requires a Release build.' }
  # A debug build can be installed for testing but must not replace the phone release.
  $candidateOnly = $Candidate.IsPresent -or ($PackageTarget.Name -eq 'Phone' -and $BuildType -eq 'Debug')
  $variant = $BuildType.ToLowerInvariant()
  $profile = $variant + $(if ($Compact) { '-compact' } else { '' })
  $directory = $PackageTarget.ArtifactDirectory
  if ($candidateOnly) { $directory += '/candidates/' + $profile }
  [pscustomobject]@{
    BuildType = $BuildType
    Compact = [bool]$Compact
    Candidate = $candidateOnly
    GradleTask = ':app:assemble' + $BuildType
    NativeTestTask = ':app:test' + $BuildType + 'UnitTest'
    BuiltApk = 'android/app/build/outputs/apk/' + $variant + '/app-' + $variant + '.apk'
    ArtifactDirectory = $directory
    StorageReport = $(if ($candidateOnly) { 'packaging-storage-' + $PackageTarget.Name.ToLowerInvariant() + '-' + $profile + '-candidate.json' } else { $PackageTarget.StorageReport })
  }
}

function Assert-TadaAndroidPackageContents {
  param(
    [Parameter(Mandatory)][string]$ApkPath,
    [Parameter(Mandatory)][ValidateSet('arm64-v8a', 'x86_64')][string]$Architecture,
    [switch]$RequireReleaseInterop
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ApkPath)
  try {
    $abis = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName -match '^lib/([^/]+)/[^/]+\.so$') { [void]$abis.Add($Matches[1]) }
      if ($entry.FullName -match '^assets/mlkit-google-ocr-models/' -or
          $entry.FullName -match '^lib/[^/]+/libmlkit_[^/]*ocr[^/]*\.so$') {
        throw 'Bundled OCR remains in this APK. Rebuild after removing the dependency; latest was preserved.'
      }
    }
    if ($abis.Count -ne 1 -or -not $abis.Contains($Architecture)) {
      throw ('APK must contain only ' + $Architecture + '; found: ' + (($abis | Sort-Object) -join ', ') + '. Latest was preserved.')
    }
    if ($RequireReleaseInterop) {
      # These classes are reached by JNI/WorkManager rather than Java callers.
      # Check the actual DEX output, where an R8 reachability mistake is visible.
      $required = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
      foreach ($name in @(
        'com/facebook/react/devsupport/CxxInspectorPackagerConnection',
        'com/facebook/react/devsupport/CxxInspectorPackagerConnection$WebSocketDelegate',
        'com/facebook/react/devsupport/CxxInspectorPackagerConnection$DelegateImpl',
        'com/facebook/react/devsupport/CxxInspectorPackagerConnection$IWebSocket',
        'com/tomorrowai/TomorrowPlatformModule','com/tomorrowai/PhotoIndexModule',
        'com/tomorrowai/AppInputsModule','com/tomorrowai/HealthDataModule',
        'com/tomorrowai/PhoneSourcesModule','com/tomorrowai/PhotoIndexWorker',
        'com/tomorrowai/PhoneSourceSyncWorker'
      )) { [void]$required.Add('L' + $name + ';') }
      foreach ($dex in $archive.Entries | Where-Object FullName -Match '^classes[0-9]*\.dex$') {
        $reader = [IO.StreamReader]::new($dex.Open(), [Text.Encoding]::UTF8)
        try { $strings = $reader.ReadToEnd() } finally { $reader.Dispose() }
        foreach ($descriptor in @($required)) {
          if ($strings.Contains($descriptor)) { [void]$required.Remove($descriptor) }
        }
      }
      if ($required.Count -gt 0) { throw ('Release interop classes missing after shrinking: ' + (($required | Sort-Object) -join ', ') + '. Latest was preserved.') }
    }
    [pscustomobject]@{ Architecture = $Architecture; Bytes = (Get-Item -LiteralPath $ApkPath).Length; BundledOcr = $false; ReleaseInteropChecked = [bool]$RequireReleaseInterop }
  } finally { $archive.Dispose() }
}
