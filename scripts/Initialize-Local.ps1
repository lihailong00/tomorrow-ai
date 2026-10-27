[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$privateEnv = Join-Path $projectRoot '.env'
foreach ($folder in @('data', 'data/uploads', 'artifacts', 'artifacts/logs')) {
    New-Item -ItemType Directory -Path (Join-Path $projectRoot $folder) -Force | Out-Null
}
if (-not (Test-Path -LiteralPath $privateEnv)) {
    $randomBytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($randomBytes)
    $databasePassword = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()
    $rng.GetBytes($randomBytes)
    $encryptionKey = ([BitConverter]::ToString($randomBytes)).Replace('-', '').ToLowerInvariant()
    $rng.Dispose()
    $contents = [IO.File]::ReadAllText((Join-Path $projectRoot '.env.example'))
    $contents = $contents.Replace('POSTGRES_PASSWORD=', "POSTGRES_PASSWORD=$databasePassword")
    $contents = $contents.Replace('CONNECTOR_ENCRYPTION_KEY=', "CONNECTOR_ENCRYPTION_KEY=$encryptionKey")
    [IO.File]::WriteAllText($privateEnv, $contents, (New-Object Text.UTF8Encoding $false))
    Write-Host 'Created private .env with local credentials. Existing settings are never overwritten.'
} else {
    Write-Host 'Using existing .env.'
}
$currentContents = [IO.File]::ReadAllText($privateEnv)
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    foreach ($keyName in @('RUSTFS_ACCESS_KEY','RUSTFS_SECRET_KEY')) {
        if ($currentContents -notmatch "(?m)^$keyName=.+$") {
            $keyBytes = New-Object byte[] 32
            $rng.GetBytes($keyBytes)
            $keyValue = ([BitConverter]::ToString($keyBytes)).Replace('-', '').ToLowerInvariant()
            if ($currentContents -match "(?m)^$keyName=$") {
                $currentContents = [Text.RegularExpressions.Regex]::Replace($currentContents, "(?m)^$keyName=$", "$keyName=$keyValue")
            } else { $currentContents += "`n$keyName=$keyValue`n" }
        }
    }
    [IO.File]::WriteAllText($privateEnv, $currentContents, (New-Object Text.UTF8Encoding $false))
} finally { $rng.Dispose() }
