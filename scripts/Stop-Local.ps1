[CmdletBinding()]
param([switch]$Infrastructure)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeFile = Join-Path $projectRoot 'data/runtime.json'
if (Test-Path -LiteralPath $runtimeFile) {
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    foreach ($entry in $runtime.processes) {
        $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $entry.path -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$entry.started_at).ToUniversalTime().Ticks) {
            $process | Stop-Process
            Write-Host "Stopped Tomorrow process $($entry.id)."
        }
    }
    Remove-Item -LiteralPath $runtimeFile
}
if ($Infrastructure) {
    Push-Location -LiteralPath $projectRoot
    try { & docker compose stop; if ($LASTEXITCODE -ne 0) { throw 'Infrastructure stop failed.' } } finally { Pop-Location }
}
Write-Host 'Saved accounts, memories, conversations, files and tasks are retained.'
