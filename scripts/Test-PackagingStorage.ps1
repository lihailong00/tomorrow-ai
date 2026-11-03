[CmdletBinding()]
param(
  [string]$EvidenceDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repoPath = Split-Path -Parent $PSScriptRoot
$publishScript = Join-Path $PSScriptRoot 'Publish-AndroidApk.ps1'
$storageScript = Join-Path $PSScriptRoot 'Project-Storage.ps1'
if (-not $EvidenceDirectory) {
  $EvidenceDirectory = Join-Path $repoPath ('artifacts/packaging-storage-tests/' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss-fff'))
}
$evidencePath = [IO.Path]::GetFullPath($EvidenceDirectory)
$fixtureRoot = Join-Path $evidencePath ('fixtures-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null
$results = [System.Collections.Generic.List[object]]::new()
$reparseFixtures = [System.Collections.Generic.List[string]]::new()
$utf8 = [Text.UTF8Encoding]::new($false)

function Write-Fixture([string]$Path, [string]$Content) {
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($Path)) -Force | Out-Null
  [IO.File]::WriteAllText($Path, $Content, $script:utf8)
}

function Assert-True($Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw ($Message + '; expected=' + [string]$Expected + '; actual=' + [string]$Actual) }
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
  $caught = $false
  try { & $Action | Out-Null } catch { $caught = $true }
  if (-not $caught) { throw $Message }
}

function File-Sha([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Invoke-Case([string]$Name, [scriptblock]$Body) {
  $started = [DateTime]::UtcNow
  try {
    & $Body
    $script:results.Add([pscustomobject]@{ Name = $Name; Status = 'pass'; Error = $null; StartedAt = $started.ToString('o') })
    Write-Host ('PASS ' + $Name)
  } catch {
    $script:results.Add([pscustomobject]@{ Name = $Name; Status = 'fail'; Error = $_.Exception.Message; Location = $_.InvocationInfo.PositionMessage; StartedAt = $started.ToString('o') })
    Write-Host ('FAIL ' + $Name + ': ' + $_.Exception.Message)
  }
}

function New-CaseDirectory([string]$Name) {
  $directory = Join-Path $script:fixtureRoot $Name
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  return $directory
}

function New-Apk([string]$Directory, [int]$Code, [string]$Filename, [string]$Package = 'com.tomorrowai', [string]$Payload = '') {
  if (-not $Filename) { $Filename = 'tada-v0.1.' + $Code + '-20261101-000000-' + $Code.ToString('000') + '.apk' }
  $path = Join-Path $Directory $Filename
  Write-Fixture $path (([ordered]@{ package = $Package; code = $Code; version = '0.1.' + $Code; payload = $Payload } | ConvertTo-Json -Compress))
  # Aged files represent completed old builds, not files another builder just created.
  [IO.File]::SetLastWriteTimeUtc($path, [DateTime]::UtcNow.AddHours(-2))
  return $path
}

function Publish-Fixture([string]$Path, [string]$Directory) {
  $output = @(& $script:publishScript -ApkPath $Path -OutputDirectory $Directory -AaptPath $script:fakeAapt -LockTimeoutSeconds 1)
  $publication = @($output | Where-Object { $_.PSObject.Properties['Published'] })
  if ($publication.Count -ne 1) { throw 'Publisher must return exactly one result object.' }
  return $publication[0]
}

function Published-State([string]$Directory) {
  $state = [ordered]@{}
  foreach ($name in @('tada-latest.apk', 'tomorrow-ai-latest.apk', 'tada-rollback.apk', 'latest.json')) {
    $path = Join-Path $Directory $name
    if ([IO.File]::Exists($path)) { $state[$name] = File-Sha $path }
    else { $state[$name] = $null }
  }
  return ($state | ConvertTo-Json -Compress)
}

function New-TwoPublished([string]$Name) {
  $directory = New-CaseDirectory $Name
  $first = New-Apk $directory 1 ''
  $firstHash = File-Sha $first
  Publish-Fixture $first $directory | Out-Null
  $second = New-Apk $directory 2 ''
  $secondHash = File-Sha $second
  Publish-Fixture $second $directory | Out-Null
  return [pscustomobject]@{ Directory = $directory; FirstHash = $firstHash; Second = $second; SecondHash = $secondHash }
}

function New-GitFixture([string]$Name) {
  $directory = New-CaseDirectory $Name
  & git -C $directory init --quiet 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fixture git init failed.' }
  Write-Fixture (Join-Path $directory 'source.txt') 'source-fixture'
  & git -C $directory add source.txt 2>&1 | Out-Null
  & git -C $directory -c user.name=PackagingTests -c user.email=packaging-tests@example.invalid commit --quiet -m fixture 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fixture git commit failed.' }
  return $directory
}

$fakeAapt = Join-Path $fixtureRoot 'fake-aapt.ps1'
Write-Fixture $fakeAapt @'
$ErrorActionPreference = 'Stop'
try {
  $apk = Get-Content -LiteralPath $args[2] -Raw | ConvertFrom-Json
  if (-not $apk.package -or -not $apk.code) { exit 1 }
  Write-Output ("package: name='" + $apk.package + "' versionCode='" + $apk.code + "' versionName='" + $apk.version + "'")
  exit 0
} catch { exit 1 }
'@

try {
  Invoke-Case 'publish-first-and-upgrade-keeps-verified-rollback' {
    $directory = New-CaseDirectory 'upgrade'
    $first = New-Apk $directory 1 ''
    $hash = File-Sha $first
    $initial = Publish-Fixture $first $directory
    Assert-True $initial.Published 'First package was not published.'
    Assert-Equal (File-Sha (Join-Path $directory 'tada-latest.apk')) $hash 'First latest hash'
    $second = New-Apk $directory 2 ''
    $newHash = File-Sha $second
    $upgrade = Publish-Fixture $second $directory
    Assert-True $upgrade.Published 'Upgrade was not published.'
    Assert-Equal (File-Sha (Join-Path $directory 'tada-latest.apk')) $newHash 'Latest after upgrade'
    Assert-Equal (File-Sha (Join-Path $directory 'tomorrow-ai-latest.apk')) $newHash 'Legacy latest after upgrade'
    Assert-Equal (File-Sha (Join-Path $directory 'tada-rollback.apk')) $hash 'Verified previous package preserved'
    $metadata = Get-Content -LiteralPath (Join-Path $directory 'latest.json') -Raw | ConvertFrom-Json
    Assert-Equal ([int]$metadata.version_code) 2 'Committed metadata version'
    Assert-Equal $metadata.sha256 $newHash 'Committed metadata hash'
    Assert-Equal $metadata.rollback.sha256 $hash 'Rollback metadata hash'
    Assert-True ([IO.File]::Exists($second)) 'Current versioned source was deleted.'
  }

  Invoke-Case 'identical-republish-keeps-distinct-rollback' {
    $fixture = New-TwoPublished 'republish'
    $rollbackHash = File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')
    Publish-Fixture $fixture.Second $fixture.Directory | Out-Null
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')) $rollbackHash 'Identical republish replaced rollback with latest'
  }

  Invoke-Case 'schema-one-folder-adopts-verified-old-package-as-rollback' {
    $fixture = New-TwoPublished 'schema-one'
    Remove-Item -LiteralPath (Join-Path $fixture.Directory 'tada-rollback.apk') -Force
    $metadataPath = Join-Path $fixture.Directory 'latest.json'
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $metadata.schema_version = 1
    $metadata.PSObject.Properties.Remove('rollback')
    Write-Fixture $metadataPath ($metadata | ConvertTo-Json -Depth 5)
    $old = New-Apk $fixture.Directory 1 ''
    $oldHash = File-Sha $old
    Publish-Fixture $fixture.Second $fixture.Directory | Out-Null
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')) $oldHash 'Schema-one folder did not retain a verified older package'
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-latest.apk')) $fixture.SecondHash 'Schema-one upgrade changed the latest APK'
  }

  Invoke-Case 'same-version-rebuild-retains-rollback-and-removes-previous-source' {
    $fixture = New-TwoPublished 'same-code-rebuild'
    $replacement = New-Apk $fixture.Directory 2 'tada-v0.1.2-20261101-000001-002.apk' 'com.tomorrowai' 'rebuilt-same-version'
    $replacementHash = File-Sha $replacement
    Publish-Fixture $replacement $fixture.Directory | Out-Null
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-latest.apk')) $replacementHash 'Same-version rebuild latest hash'
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')) $fixture.SecondHash 'Same-version rebuild did not retain previous binary'
    Assert-True (-not [IO.File]::Exists($fixture.Second)) 'Previous committed same-version source accumulated after verified rollback snapshot.'
    Assert-True ([IO.File]::Exists($replacement)) 'New same-version source was deleted.'
  }

  Invoke-Case 'identical-new-filename-republish-prunes-previous-source-without-replacing-rollback' {
    $fixture = New-TwoPublished 'same-hash-new-name'
    $replacement = New-Apk $fixture.Directory 2 'tada-v0.1.2-20261101-000001-002.apk'
    Assert-Equal (File-Sha $replacement) $fixture.SecondHash 'Identical fixture bytes differ'
    Publish-Fixture $replacement $fixture.Directory | Out-Null
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')) $fixture.FirstHash 'Samehash republish replaced distinct rollback'
    Assert-True (-not [IO.File]::Exists($fixture.Second)) 'Previous committed samehash source accumulated.'
    Assert-True ([IO.File]::Exists($replacement)) 'New source was deleted.'
  }

  Invoke-Case 'older-candidate-never-downgrades-latest' {
    $fixture = New-TwoPublished 'downgrade'
    $before = Published-State $fixture.Directory
    $old = New-Apk $fixture.Directory 1 '' 'com.tomorrowai' 'different-old-build'
    $result = Publish-Fixture $old $fixture.Directory
    Assert-True (-not $result.Published) 'An older version was published.'
    Assert-Equal (Published-State $fixture.Directory) $before 'Downgrade mutated current delivery files'
  }

  Invoke-Case 'invalid-incoming-preserves-latest-and-rollback' {
    $fixture = New-TwoPublished 'invalid'
    $before = Published-State $fixture.Directory
    $bad = Join-Path $fixture.Directory 'tada-v0.1.3-20261101-000000-003.apk'
    Write-Fixture $bad 'invalid-apk'
    Assert-Throws { Publish-Fixture $bad $fixture.Directory } 'Invalid incoming package was accepted.'
    Assert-Equal (Published-State $fixture.Directory) $before 'Invalid input mutated delivery files'
  }

  Invoke-Case 'corrupt-latest-metadata-fails-closed' {
    $fixture = New-TwoPublished 'corrupt-metadata'
    Write-Fixture (Join-Path $fixture.Directory 'latest.json') '{broken'
    $before = Published-State $fixture.Directory
    $third = New-Apk $fixture.Directory 3 ''
    Assert-Throws { Publish-Fixture $third $fixture.Directory } 'Corrupt metadata was ignored.'
    Assert-Equal (Published-State $fixture.Directory) $before 'Corrupt metadata caused unsafe mutation'
  }

  Invoke-Case 'rollback-hash-mismatch-fails-closed' {
    $fixture = New-TwoPublished 'rollback-hash'
    $path = Join-Path $fixture.Directory 'tada-rollback.apk'
    Write-Fixture $path (([ordered]@{ package='com.tomorrowai';code=1;version='0.1.1';payload='tampered' } | ConvertTo-Json -Compress))
    $before = Published-State $fixture.Directory
    $third = New-Apk $fixture.Directory 3 ''
    Assert-Throws { Publish-Fixture $third $fixture.Directory } 'Rollback hash mismatch was ignored.'
    Assert-Equal (Published-State $fixture.Directory) $before 'Mismatched rollback caused delivery mutation'
  }

  foreach ($lockedAlias in @('tada-latest.apk','tomorrow-ai-latest.apk','tada-rollback.apk','latest.json')) {
    Invoke-Case ('locked-' + $lockedAlias + '-restores-whole-transaction') {
      $fixture = New-TwoPublished ('locked-' + $lockedAlias.Replace('.','-'))
      $before = Published-State $fixture.Directory
      $third = New-Apk $fixture.Directory 3 ''
      $stream = [IO.File]::Open((Join-Path $fixture.Directory $lockedAlias), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
      try {
        Assert-Throws { Publish-Fixture $third $fixture.Directory } ('Locked ' + $lockedAlias + ' did not prevent replacement.')
        Assert-Equal (Published-State $fixture.Directory) $before 'Failed publish did not restore all prior delivery files'
      } finally { $stream.Dispose() }
    }
  }

  Invoke-Case 'publish-lock-prevents-second-writer' {
    $fixture = New-TwoPublished 'publisher-lease'
    $before = Published-State $fixture.Directory
    $third = New-Apk $fixture.Directory 3 ''
    $lock = [IO.File]::Open((Join-Path $fixture.Directory '.publish-android.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
      Assert-Throws { Publish-Fixture $third $fixture.Directory } 'Publisher ignored another writer lease.'
      Assert-Equal (Published-State $fixture.Directory) $before 'Blocked writer mutated delivery files'
    } finally { $lock.Dispose() }
  }

  Invoke-Case 'prune-only-recognized-old-packages-and-keep-newer-pending-custom-and-foreign' {
    $fixture = New-TwoPublished 'retention'
    $old = New-Apk $fixture.Directory 1 'tada-v0.1.1-20261031-000000-001.apk' 'com.tomorrowai' 'obsolete'
    $pending = New-Apk $fixture.Directory 5 ''
    $custom = New-Apk $fixture.Directory 1 'customer-copy.apk'
    $foreign = New-Apk $fixture.Directory 1 'tada-v0.1.1-20261030-000000-001.apk' 'other.application'
    $recent = New-Apk $fixture.Directory 1 'tada-v0.1.1-20261101-010000-001.apk' 'com.tomorrowai' 'recent'
    [IO.File]::SetLastWriteTimeUtc($recent, [DateTime]::UtcNow)
    $private = Join-Path $fixture.Directory 'signing.keystore'
    Write-Fixture $private 'private-test-fixture'
    $third = New-Apk $fixture.Directory 3 ''
    Publish-Fixture $third $fixture.Directory | Out-Null
    Assert-True (-not [IO.File]::Exists($old)) 'Obsolete verified generated package was not pruned.'
    foreach ($path in @($pending,$custom,$foreign,$recent,$private,$third)) {
      Assert-True ([IO.File]::Exists($path)) ('Protected/unowned candidate deleted: ' + [IO.Path]::GetFileName($path))
    }
    Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-rollback.apk')) $fixture.SecondHash 'Rollback was not previous latest'
  }

  Invoke-Case 'locked-obsolete-package-is-skipped-without-breaking-latest' {
    $fixture = New-TwoPublished 'locked-old'
    $old = New-Apk $fixture.Directory 1 'tada-v0.1.1-20261031-000000-001.apk' 'com.tomorrowai' 'locked-old'
    $third = New-Apk $fixture.Directory 3 ''
    $stream = [IO.File]::Open($old, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try {
      $result = Publish-Fixture $third $fixture.Directory
      Assert-True $result.Published 'Locked obsolete package broke a successful publication.'
      Assert-True ([IO.File]::Exists($old)) 'Locked obsolete package unexpectedly disappeared.'
      Assert-Equal (File-Sha (Join-Path $fixture.Directory 'tada-latest.apk')) (File-Sha $third) 'Latest invalid after old-package cleanup failure'
    } finally { $stream.Dispose() }
  }

  Invoke-Case 'publisher-refuses-output-junction' {
    $target = New-CaseDirectory 'junction-target'
    $source = New-Apk $target 1 ''
    $junction = Join-Path $fixtureRoot 'publisher-junction'
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    $reparseFixtures.Add($junction)
    Assert-Throws { Publish-Fixture $source $junction } 'Publisher accepted a reparse output directory.'
    Assert-True (-not [IO.File]::Exists((Join-Path $target 'tada-latest.apk'))) 'Junction target was mutated.'
  }

  Invoke-Case 'publisher-refuses-input-junction' {
    $target = New-CaseDirectory 'source-junction-target'
    $source = New-Apk $target 1 ''
    $outputDirectory = New-CaseDirectory 'source-junction-output'
    $junction = Join-Path $fixtureRoot 'publisher-source-junction'
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    $reparseFixtures.Add($junction)
    $linkedSource = Join-Path $junction ([IO.Path]::GetFileName($source))
    Assert-Throws { Publish-Fixture $linkedSource $outputDirectory } 'Publisher accepted a reparse input path.'
    Assert-True (-not [IO.File]::Exists((Join-Path $outputDirectory 'tada-latest.apk'))) 'Output was changed before rejecting the linked source.'
  }

  Invoke-Case 'publisher-resolves-relative-input-and-output-from-powershell-location' {
    $directory = New-CaseDirectory 'relative-publication'
    $source = New-Apk (Join-Path $directory 'input') 1 ''
    $oldLocation = (Get-Location).Path
    Set-Location -LiteralPath $directory
    try {
      $result = Publish-Fixture ('input/' + [IO.Path]::GetFileName($source)) 'delivery'
      Assert-True $result.Published 'Relative input/output publication failed.'
      Assert-Equal (File-Sha (Join-Path $directory 'delivery/tada-latest.apk')) (File-Sha $source) 'Relative output was resolved against process cwd instead of PowerShell cwd'
    } finally { Set-Location -LiteralPath $oldLocation }
  }

  Invoke-Case 'publisher-rejects-non-filesystem-provider-paths' {
    $directory = New-CaseDirectory 'provider-boundary'
    $source = New-Apk $directory 1 ''
    Assert-Throws { Publish-Fixture $source 'Env:TADA_PACKAGING_TEST_OUTPUT' } 'Non-filesystem output provider was accepted.'
    Assert-Throws { Publish-Fixture 'Env:PATH' $directory } 'Non-filesystem input provider was accepted.'
    Assert-True (-not [IO.File]::Exists((Join-Path $directory 'tada-latest.apk'))) 'Provider rejection changed output files.'
  }

  . $storageScript

  Invoke-Case 'measure-overlapping-roots-once-and-include-external-paths' {
    $directory = New-GitFixture 'measure-dedup'
    $baseline = Get-TadaStorageUsage -RepoPath $directory
    $child = Join-Path $directory 'nested/output'
    Write-Fixture (Join-Path $child 'bytes.bin') ('a' * 101)
    $external = New-CaseDirectory 'measure-external'
    Write-Fixture (Join-Path $external 'bytes.bin') ('b' * 33)
    $usage = Get-TadaStorageUsage -RepoPath $directory -AdditionalPaths @($child,$child,$external,(Join-Path $external 'bytes.bin'))
    Assert-Equal ([long]($usage.TotalBytes - $baseline.TotalBytes)) ([long]134) 'Overlapping roots were double counted or external path omitted'
    Assert-Equal $usage.Status 'within_budget' 'Tiny complete fixture status'
  }

  Invoke-Case 'measure-discovers-linked-worktrees' {
    $directory = New-GitFixture 'worktree-main'
    $linked = Join-Path $fixtureRoot 'worktree-linked'
    & git -C $directory worktree add --quiet --detach $linked HEAD 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture linked worktree creation failed.' }
    Write-Fixture (Join-Path $linked 'untracked.bin') ('c' * 77)
    $usage = Get-TadaStorageUsage -RepoPath $linked
    $paths = @($usage.Roots | ForEach-Object { [IO.Path]::GetFullPath($_.Path) })
    Assert-True ($paths -icontains [IO.Path]::GetFullPath($directory)) 'Primary worktree was omitted from linked worktree scan.'
    Assert-True ($paths -icontains [IO.Path]::GetFullPath($linked)) 'Linked worktree was omitted from scan.'
    Assert-Equal $usage.Status 'within_budget' 'Linked worktree discovery incomplete'
  }

  Invoke-Case 'default-retained-limit-is-20gb' {
    $directory = New-GitFixture 'default-storage-limit'
    $usage = Get-TadaStorageUsage -RepoPath $directory
    Assert-Equal $usage.BudgetBytes 20000000000 'Default retained limit is not 20 GB.'
    Assert-Equal $usage.WarningBytes 20000000000 'Default warning threshold should not trigger below 20 GB.'
  }

  Invoke-Case 'preflight-cleanup-is-rejected-and-warm-cache-preserved' {
    $directory = New-GitFixture 'no-preflight-cleanup'
    $cache = Join-Path $directory 'apps/mobile/android/app/build/warm.bin'
    Write-Fixture $cache 'warm-cache'
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { Assert-Throws { Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Preflight } 'Preflight cleanup was allowed.' }
    finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($cache)) 'Preflight rejection changed the cache.'
  }

  Invoke-Case 'budget-and-warning-boundaries-use-real-measured-bytes' {
    $directory = New-GitFixture 'thresholds'
    $usage = Get-TadaStorageUsage -RepoPath $directory
    [long]$bytes = $usage.TotalBytes
    $atWarning = Get-TadaStorageUsage -RepoPath $directory -BudgetBytes ($bytes + 100) -WarningBytes $bytes
    Assert-Equal $atWarning.Status 'warning' 'Warning threshold boundary'
    $atBudget = Get-TadaStorageUsage -RepoPath $directory -BudgetBytes $bytes -WarningBytes $bytes
    Assert-Equal $atBudget.Status 'warning' 'Exact budget should not be over budget'
    $aboveBudget = Get-TadaStorageUsage -RepoPath $directory -BudgetBytes ($bytes - 1) -WarningBytes ($bytes - 1)
    Assert-Equal $aboveBudget.Status 'over_budget' 'Over-budget threshold'
    Assert-Throws { Get-TadaStorageUsage -RepoPath $directory -BudgetBytes 100 -WarningBytes 101 } 'Invalid thresholds were accepted.'
  }

  Invoke-Case 'local-extra-path-config-is-measurement-only' {
    $directory = New-GitFixture 'local-config'
    $external = New-CaseDirectory 'config-external'
    $privateFile = Join-Path $external 'private.db'
    Write-Fixture $privateFile 'private-db-fixture'
    Write-Fixture (Join-Path $directory '.tada-storage.local.json') (([ordered]@{schema_version=1;additional_measure_paths=@($external)} | ConvertTo-Json))
    $usage = Get-TadaStorageUsage -RepoPath $directory
    Assert-True (@($usage.Roots | Where-Object Path -eq $external).Count -eq 1) 'External config path was not measured.'
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success | Out-Null }
    finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($privateFile)) 'Measurement config granted deletion authority.'
  }

  Invoke-Case 'register-external-path-persists-and-is-shared-by-linked-worktrees' {
    $directory = New-GitFixture 'registered-main'
    $linked = Join-Path $fixtureRoot 'registered-linked'
    & git -C $directory worktree add --quiet --detach $linked HEAD 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Registered fixture worktree creation failed.' }
    $external = New-CaseDirectory 'registered-native'
    Write-Fixture (Join-Path $external 'old-output.bin') 'external-accounting'
    $lease = Enter-TadaPackagingLease -RepoPath $linked -TimeoutSeconds 0
    try { Register-TadaStoragePaths -RepoPath $linked -Lease $lease -AdditionalPaths @($external,$external) }
    finally { $lease.Stream.Dispose() }
    $config = Get-Content -LiteralPath (Join-Path $directory '.tada-storage.local.json') -Raw | ConvertFrom-Json
    Assert-Equal @($config.additional_measure_paths).Count 1 'Register created duplicate external paths'
    $usage = Get-TadaStorageUsage -RepoPath $directory
    Assert-True (@($usage.Roots | Where-Object Path -eq $external).Count -eq 1) 'Later build in another worktree would omit registered external output.'
  }

  Invoke-Case 'lease-serializes-worktrees-and-disposed-lease-cannot-clean' {
    $directory = New-GitFixture 'build-lease-main'
    $linked = Join-Path $fixtureRoot 'build-lease-linked'
    & git -C $directory worktree add --quiet --detach $linked HEAD 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Lease fixture linked worktree failed.' }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { Assert-Throws { Enter-TadaPackagingLease -RepoPath $linked -TimeoutSeconds 0 } 'Linked worktree ignored shared build lease.' }
    finally { $lease.Stream.Dispose() }
    Assert-Throws { Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success } 'Disposed lease authorized cleanup.'
  }

  Invoke-Case 'cleanup-removes-only-own-allowlisted-caches' {
    $directory = New-GitFixture 'cache-allowlist'
    $other = New-CaseDirectory 'other-workspace'
    $foreignCache = Join-Path $other 'apps/mobile/android/app/build/foreign.bin'
    Write-Fixture $foreignCache 'foreign-cache'
    foreach ($relative in @('apps/mobile/android/app/build','apps/mobile/android/build','apps/mobile/android/app/.cxx','apps/mobile/android/.gradle')) {
      Write-Fixture (Join-Path $directory ($relative + '/generated.bin')) ('cache-' + $relative)
    }
    $protected = @('.env','data/user.sqlite','uploads/image.jpg','artifacts/apk/tada-latest.apk','artifacts/apk/tada-rollback.apk','apps/mobile/node_modules/package/index.js','source.txt')
    foreach ($relative in $protected) { Write-Fixture (Join-Path $directory $relative) ('protected-' + $relative) }
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { $result = Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success }
    finally { $lease.Stream.Dispose() }
    Assert-Equal @($result.Items | Where-Object Status -eq 'removed').Count 4 'Allowlisted generated cache removal count'
    Assert-True ($result.RemovedBytes -gt 0) 'Freed-byte report is empty.'
    foreach ($relative in $protected) { Assert-True ([IO.File]::Exists((Join-Path $directory $relative))) ('Necessary file deleted: ' + $relative) }
    Assert-True ([IO.File]::Exists($foreignCache)) 'Another workspace cache was deleted.'
  }

  Invoke-Case 'cleanup-preserves-protected-and-tracked-files-inside-cache' {
    $directory = New-GitFixture 'cache-protected'
    $private = Join-Path $directory 'apps/mobile/android/app/build/user.db'
    $tracked = Join-Path $directory 'apps/mobile/android/build/custom-source.kt'
    Write-Fixture $private 'private-fixture'
    Write-Fixture $tracked 'tracked-source-fixture'
    & git -C $directory add --force -- apps/mobile/android/build/custom-source.kt 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Fixture tracked-cache setup failed.' }
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { $result = Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success }
    finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($private)) 'Private file in cache directory was deleted.'
    Assert-True ([IO.File]::Exists($tracked)) 'Tracked source in cache directory was deleted.'
    Assert-Equal @($result.Items | Where-Object Status -eq 'removed').Count 0 'Protected cache directory was removed'
  }

  Invoke-Case 'cleanup-preserves-lone-database-sidecars-and-signing-certificates' {
    $directory = New-GitFixture 'cache-private-sidecars'
    $cache = Join-Path $directory 'apps/mobile/android/app/build'
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try {
      foreach ($name in @('user.sqlite-wal','user.sqlite3-wal','user.sqlite-journal','user.db-shm','user.db-journal','user.sqlite3-shm','signing.pfx','signing.ppk','signing.crt','id_ed25519')) {
        $private = Join-Path $cache $name
        Write-Fixture $private 'private-sidecar-or-signing-fixture'
        Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success | Out-Null
        Assert-True ([IO.File]::Exists($private)) ('Lone database/signing file was deleted: ' + $name)
        Remove-Item -LiteralPath $private -Force
      }
    } finally { $lease.Stream.Dispose() }
  }

  Invoke-Case 'active-build-inspection-prevents-cache-cleanup' {
    $directory = New-GitFixture 'cache-active'
    $file = Join-Path $directory 'apps/mobile/android/app/build/generated.bin'
    Write-Fixture $file 'active-cache'
    function Get-TadaActiveBuildProcesses { return @([pscustomobject]@{Name='cmake.exe';ProcessId=123}) }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { $result = Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Failure }
    finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($file)) 'Active build cache was removed.'
    Assert-Equal @($result.Items | Where-Object Status -eq 'skipped-active-build').Count 1 'Active process skip was not recorded'
  }

  Invoke-Case 'hidden-java-command-line-is-treated-as-uncertain-active-build' {
    function Get-CimInstance {
      [CmdletBinding()]
      param([string]$ClassName)
      return @(
        [pscustomobject]@{Name='java.exe';CommandLine=$null;ProcessId=111},
        [pscustomobject]@{Name='javaw.exe';CommandLine=' ';ProcessId=112},
        [pscustomobject]@{Name='java.exe';CommandLine='java -jar ordinary-service.jar';ProcessId=222},
        [pscustomobject]@{Name='java.exe';CommandLine='java org.gradle.launcher.daemon';ProcessId=333},
        [pscustomobject]@{Name='cargo.exe';CommandLine='cargo test';ProcessId=444}
      )
    }
    $active = @(Get-TadaActiveBuildProcesses)
    $ids = @($active | ForEach-Object ProcessId)
    foreach ($id in @(111,112,333,444)) { Assert-True ($ids -contains $id) ('Uncertain/active build was not detected: ' + $id) }
    Assert-True ($ids -notcontains 222) 'Clearly unrelated Java service was classified as a build.'
  }

  Invoke-Case 'external-cache-requires-exact-ownership-and-empty-registration' {
    $directory = New-GitFixture 'external-owner'
    $owned = Join-Path $fixtureRoot 'owned-native'
    $unowned = New-CaseDirectory 'unowned-native'
    $private = Join-Path $unowned 'existing.bin'
    Write-Fixture $private 'existing-unowned-data'
    Initialize-TadaNativeBuildDirectory -RepoPath $directory -NativeBuildDirectory $owned
    Initialize-TadaNativeBuildDirectory -RepoPath $directory -NativeBuildDirectory $unowned
    Write-Fixture (Join-Path $owned 'generated.bin') 'owned-native-generated'
    Assert-True (-not [IO.File]::Exists((Join-Path $unowned '.tada-build-owner.json'))) 'Nonempty directory was adopted for deletion.'
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try {
      Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success -NativeBuildDirectory $unowned | Out-Null
      Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success -NativeBuildDirectory $owned | Out-Null
    } finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($private)) 'Unowned external directory was deleted.'
    Assert-True (-not [IO.Directory]::Exists($owned)) 'Owned external generated directory was not reclaimed.'
  }

  Invoke-Case 'rust-target-is-opt-in-and-requires-cargo-marker' {
    $directory = New-GitFixture 'rust-cache'
    $file = Join-Path $directory 'target/debug/generated.bin'
    Write-Fixture $file 'rust-fixture'
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try {
      Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success -IncludeRustTarget | Out-Null
      Assert-True ([IO.File]::Exists($file)) 'Unmarked target was deleted.'
      Write-Fixture (Join-Path $directory 'target/CACHEDIR.TAG') 'Signature: 8a477f597d28d172789f06886806bc55'
      Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success | Out-Null
      Assert-True ([IO.File]::Exists($file)) 'Rust target was deleted without opt-in.'
      Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success -IncludeRustTarget | Out-Null
      Assert-True (-not [IO.File]::Exists($file)) 'Explicitly allowed marked target was not reclaimed.'
    } finally { $lease.Stream.Dispose() }
  }

  Invoke-Case 'reparse-cache-and-measurement-links-fail-safe' {
    $directory = New-GitFixture 'reparse-cache'
    $target = New-CaseDirectory 'reparse-cache-target'
    $private = Join-Path $target 'must-survive.bin'
    Write-Fixture $private 'outside-data'
    $cacheParent = Join-Path $directory 'apps/mobile/android/app'
    New-Item -ItemType Directory -Path $cacheParent -Force | Out-Null
    $junction = Join-Path $cacheParent 'build'
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    $reparseFixtures.Add($junction)
    $usage = Get-TadaStorageUsage -RepoPath $directory
    Assert-Equal $usage.Status 'incomplete' 'Reparse data was silently omitted from complete accounting'
    Assert-True ($usage.SkippedLinks.Count -gt 0) 'Reparse measurement skip was not reported.'
    function Get-TadaActiveBuildProcesses { return @() }
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    try { Invoke-TadaBuildCacheCleanup -RepoPath $directory -Lease $lease -Phase Success | Out-Null }
    finally { $lease.Stream.Dispose() }
    Assert-True ([IO.File]::Exists($private)) 'Cleanup traversed a cache junction.'
  }

  foreach ($simulatedBytes in @(13000000000,20000000000,21000000000)) {
  Invoke-Case ('android-build-failure-postbuild-limit-' + $simulatedBytes) {
    $directory = New-GitFixture ('build-integration-' + $simulatedBytes)
    $scriptDirectory = Join-Path $directory 'scripts'
    New-Item -ItemType Directory -Path $scriptDirectory -Force | Out-Null
    $buildCopy = Join-Path $scriptDirectory 'Build-Android.ps1'
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'Build-Android.ps1') -Destination $buildCopy
    $targetSelector = Join-Path $PSScriptRoot 'Android-PackageTargets.ps1'
    if ([IO.File]::Exists($targetSelector)) {
      Copy-Item -LiteralPath $targetSelector -Destination (Join-Path $scriptDirectory 'Android-PackageTargets.ps1')
    }
    # Keep cleanup process inspection deterministic and simulate a temporary
    # 13/20/21 GB totals without allocating large files or touching real caches.
    $helper = [IO.File]::ReadAllText($storageScript) + @'

function Get-TadaActiveBuildProcesses { return @() }
$script:FixtureRealStorageUsage = (Get-Command Get-TadaStorageUsage).ScriptBlock
function Get-TadaStorageUsage {
  param([string]$RepoPath, [string[]]$AdditionalPaths = @())
  $usage = & $script:FixtureRealStorageUsage -RepoPath $RepoPath -AdditionalPaths $AdditionalPaths
  $usage.TotalBytes = __SIMULATED_BYTES__
  $usage.Status = if ($usage.TotalBytes -gt $usage.BudgetBytes) { 'over_budget' } else { 'within_budget' }
  return $usage
}
'@
    $helper = $helper.Replace('__SIMULATED_BYTES__', [string]$simulatedBytes)
    Write-Fixture (Join-Path $scriptDirectory 'Project-Storage.ps1') $helper
    $apkDirectory = Join-Path $directory 'artifacts/apk'
    New-Item -ItemType Directory -Path $apkDirectory -Force | Out-Null
    $first = New-Apk $apkDirectory 1 ''
    Publish-Fixture $first $apkDirectory | Out-Null
    $second = New-Apk $apkDirectory 2 ''
    Publish-Fixture $second $apkDirectory | Out-Null
    $before = Published-State $apkDirectory
    $cache = Join-Path $directory 'apps/mobile/android/app/build/generated.bin'
    Write-Fixture $cache 'failed-build-cache'
    $rustCache = Join-Path $directory 'target/reusable-cache.bin'
    Write-Fixture (Join-Path $directory 'target/CACHEDIR.TAG') 'Signature: 8a477f597d28d172789f06886806bc55'
    Write-Fixture $rustCache 'preserve-for-parallel-rust-build'
    Write-Fixture (Join-Path $directory '.env') 'keep-private-fixture'
    $node = Join-Path $directory 'fake-tools/node-fails.ps1'
    Write-Fixture $node @'
$observed = [ordered]@{ gradle=$env:GRADLE_USER_HOME; cargo=$env:CARGO_TARGET_DIR
  cache_present_at_compile=[IO.File]::Exists((Join-Path $PSScriptRoot '../apps/mobile/android/app/build/generated.bin')) }
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'observed-env.json'), ($observed | ConvertTo-Json))
exit 42
'@
    $java = Join-Path $directory 'fake-tools/jdk'
    foreach ($name in @('java.exe','javac.exe','jlink.exe')) { Write-Fixture (Join-Path $java ('bin/' + $name)) 'fixture-only' }
    $sdk = Join-Path $directory 'fake-tools/sdk'
    New-Item -ItemType Directory -Path $sdk -Force | Out-Null
    $nativeName = 'build-integration-native-' + $simulatedBytes
    $native = Join-Path $fixtureRoot $nativeName
    $oldLocation = (Get-Location).Path
    $oldJava = $env:JAVA_HOME
    $oldGradle = [Environment]::GetEnvironmentVariable('GRADLE_USER_HOME','Process')
    $oldCargo = [Environment]::GetEnvironmentVariable('CARGO_TARGET_DIR','Process')
    $env:GRADLE_USER_HOME = 'relative-gradle-cache'
    $env:CARGO_TARGET_DIR = 'relative-cargo-cache'
    Set-Location -LiteralPath $directory
    try {
      Assert-Throws { & $buildCopy -NodePath $node -JavaHome $java -AndroidHome $sdk -NativeBuildDirectory ('../' + $nativeName) -SkipInstall -PreserveRustTarget -EstimatedBuildBytes 0 } 'Simulated TypeScript failure was not reported.'
      Assert-Equal (Get-Location).Path $directory 'Build failure did not restore its entry working directory'
      Assert-Equal $env:GRADLE_USER_HOME 'relative-gradle-cache' 'Relative Gradle environment was not restored after failure'
      Assert-Equal $env:CARGO_TARGET_DIR 'relative-cargo-cache' 'Relative Cargo environment was not restored after failure'
    } finally {
      Set-Location -LiteralPath $oldLocation
      if ($null -eq $oldGradle) { Remove-Item -LiteralPath 'Env:GRADLE_USER_HOME' -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable('GRADLE_USER_HOME',$oldGradle,'Process') }
      if ($null -eq $oldCargo) { Remove-Item -LiteralPath 'Env:CARGO_TARGET_DIR' -ErrorAction SilentlyContinue }
      else { [Environment]::SetEnvironmentVariable('CARGO_TARGET_DIR',$oldCargo,'Process') }
    }
    Assert-Equal (Published-State $apkDirectory) $before 'Build failure changed latest or rollback'
    Assert-Equal ([IO.File]::Exists($cache)) ($simulatedBytes -le 20000000000) 'Post-build cleanup did not respect the 20 GB limit.'
    Assert-True ([IO.File]::Exists((Join-Path $directory '.env'))) 'Failure cleanup deleted private configuration.'
    $reportPath = Join-Path $directory 'artifacts/packaging-storage.json'
    Assert-True ([IO.File]::Exists($reportPath)) 'Failure finally did not write a storage report.'
    $buildReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
    Assert-True (-not $buildReport.build_succeeded) 'Failed build report claimed success.'
    if ($simulatedBytes -gt 20000000000) { Assert-Equal $buildReport.post_cleanup.Phase 'Failure' 'Build failure used wrong cleanup phase' }
    else { Assert-True ($null -eq $buildReport.post_cleanup) 'Within-limit build discarded warm caches.' }
    Assert-True ($null -ne $buildReport.before -and $null -ne $buildReport.after) 'Pre/post measurements missing from report.'
    Assert-Equal $buildReport.before.TotalBytes $simulatedBytes 'Temporary usage fixture was not exercised.'
    Assert-True ($null -eq $buildReport.pre_cleanup) 'Build ran a budget-triggered preflight cleanup.'
    Assert-Equal $buildReport.budget_bytes 20000000000 '20 GB retained limit missing.'
    Assert-Equal $buildReport.budget_scope 'retained_after_housekeeping' 'Retained limit scope missing.'
    Assert-Equal $buildReport.retained_limit_status $(if ($simulatedBytes -gt 20000000000) { 'exceeded' } else { 'met' }) 'Retained limit result is inaccurate.'
    Assert-True $buildReport.temporary_overage_allowed 'Temporary build overage was not allowed.'
    Assert-True $buildReport.rust_target_preserved 'PreserveRustTarget was not recorded.'
    Assert-True ([IO.File]::Exists($rustCache)) 'PreserveRustTarget did not retain the reusable Rust cache.'
    $registered = Get-Content -LiteralPath (Join-Path $directory '.tada-storage.local.json') -Raw | ConvertFrom-Json
    Assert-True (@($registered.additional_measure_paths) -icontains $native) 'Relative native path was not normalized before changing working directory.'
    Assert-Equal ([IO.Directory]::Exists($native)) ($simulatedBytes -le 20000000000) 'External native cache cleanup did not respect the retained limit.'
    $observed = Get-Content -LiteralPath (Join-Path $directory 'fake-tools/observed-env.json') -Raw | ConvertFrom-Json
    Assert-True $observed.cache_present_at_compile 'Warm Android cache was purged before the build finished.'
    Assert-Equal $observed.gradle (Join-Path $directory 'relative-gradle-cache') 'Gradle command would use another unaccounted relative cache'
    Assert-Equal $observed.cargo (Join-Path $directory 'relative-cargo-cache') 'Cargo command would use another unaccounted relative cache'
    Assert-Equal (Get-Location).Path $oldLocation 'Build failure did not restore working directory'
    Assert-Equal $env:JAVA_HOME $oldJava 'Build failure did not restore JAVA_HOME'
    $lease = Enter-TadaPackagingLease -RepoPath $directory -TimeoutSeconds 0
    $lease.Stream.Dispose()
  }
  }
} finally {
  $sourceHashes = [ordered]@{}
  foreach ($path in @($publishScript,$storageScript,(Join-Path $PSScriptRoot 'Build-Android.ps1'),(Join-Path $PSScriptRoot 'Android-PackageTargets.ps1'),$PSCommandPath)) {
    if ([IO.File]::Exists($path)) { $sourceHashes[[IO.Path]::GetFileName($path)] = File-Sha $path }
  }
  $failed = @($results | Where-Object Status -eq 'fail')
  $report = [ordered]@{
    CreatedAt = [DateTime]::UtcNow.ToString('o')
    Environment = [ordered]@{ PowerShell = $PSVersionTable.PSVersion.ToString(); OS = [Environment]::OSVersion.VersionString }
    Scope = 'Tiny isolated filesystem fixtures. No real Android build, real APK publication, SDK or shared cache mutation.'
    SourceHashes = $sourceHashes
    Passed = @($results | Where-Object Status -eq 'pass').Count
    Failed = $failed.Count
    Cases = @($results)
  }
  New-Item -ItemType Directory -Path $evidencePath -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $evidencePath 'result.json'), (($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine), $utf8)
  foreach ($junction in $reparseFixtures) {
    if ([IO.Directory]::Exists($junction)) { [IO.Directory]::Delete($junction) }
  }
  # The only recursive deletion here is this invocation's unique test fixture tree.
  $resolvedFixture = [IO.Path]::GetFullPath($fixtureRoot)
  $evidencePrefix = $evidencePath.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedFixture.StartsWith($evidencePrefix,[StringComparison]::OrdinalIgnoreCase) -or
      -not [IO.Path]::GetFileName($resolvedFixture).StartsWith('fixtures-')) { throw 'Fixture cleanup escaped its owned directory.' }
  Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
}

Write-Host ('Packaging storage checks: ' + $report.Passed + ' passed, ' + $report.Failed + ' failed. Evidence: ' + (Join-Path $evidencePath 'result.json'))
if ($failed.Count -gt 0) { throw ('Packaging/storage regression tests failed: ' + $failed.Count) }
