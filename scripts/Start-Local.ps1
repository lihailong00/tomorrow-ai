[CmdletBinding()]
param(
    [ValidateSet('local','temporal')][string]$Mode = 'local',
    [switch]$Postgres,
    [switch]$S3,
    [switch]$NoBuild,
    [int]$Port = 8080,
    [ValidateSet('pi','direct')][string]$AgentMode = 'pi',
    [int]$AgentPort = 8090
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$previousLocation = Get-Location
$previousEnvironment = @{}
$modelEnvironmentNames = @('MODEL_BASE_URL','MODEL_API_KEY','MODEL_NAME','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL')
foreach ($name in (@('DATABASE_URL','SCHEDULER_MODE','API_BIND','AGENT_MODE','AGENT_URL','AGENT_SERVICE_TOKEN','AGENT_PORT','RUST_API_URL','AGENT_MODEL_NAME') + $modelEnvironmentNames)) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$runtimeFile = Join-Path $projectRoot 'data/runtime.json'
$startedProcesses = @()
try {
    Set-Location -LiteralPath $projectRoot
    & (Join-Path $PSScriptRoot 'Initialize-Local.ps1')
    if (Test-Path -LiteralPath $runtimeFile) {
        $previous = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        foreach ($entry in $previous.processes) {
            $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
            if ($process -and $process.Path -eq $entry.path -and $process.StartTime.ToUniversalTime().Ticks -eq ([datetime]$entry.started_at).ToUniversalTime().Ticks) {
                throw 'Tomorrow is already running. Run scripts/Stop-Local.ps1 before starting again.'
            }
        }
    }
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        throw "Port $Port is already in use. Choose -Port or stop its owning application."
    }
    if ($AgentMode -eq 'pi' -and (Get-NetTCPConnection -LocalPort $AgentPort -State Listen -ErrorAction SilentlyContinue)) {
        throw "Pi port $AgentPort is already in use. Choose -AgentPort or stop its owning application."
    }
    if ($Postgres -or $Mode -eq 'temporal') {
        & docker compose up -d
        if ($LASTEXITCODE -ne 0) { throw 'Local infrastructure could not start. Check Docker Desktop.' }
    }
    if ($Mode -eq 'temporal') {
        $temporalReady = $false
        $readinessClock = [Diagnostics.Stopwatch]::StartNew()
        while ($readinessClock.Elapsed.TotalSeconds -lt 45) {
            $clusterHealth = & docker compose exec -T temporal temporal operator cluster health 2>$null
            if ($LASTEXITCODE -eq 0 -and "$clusterHealth" -match 'SERVING') { $temporalReady = $true; break }
            Start-Sleep -Milliseconds 500
        }
        if (-not $temporalReady) { throw 'Temporal did not become SERVING. Check docker compose logs temporal.' }
    }
    if ($Postgres) {
        $passwordLine = Get-Content -LiteralPath (Join-Path $projectRoot '.env') | Where-Object { $_ -match '^POSTGRES_PASSWORD=' } | Select-Object -First 1
        $databasePassword = $passwordLine.Substring('POSTGRES_PASSWORD='.Length)
        if (-not $databasePassword) { throw 'POSTGRES_PASSWORD is missing from .env.' }
        $env:DATABASE_URL = "postgres://tomorrow:$databasePassword@127.0.0.1:54329/tomorrow"
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            & docker compose exec -T postgres pg_isready -q -U tomorrow -d tomorrow 2>$null
            if ($LASTEXITCODE -eq 0) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL did not become ready.' }
    }
    $env:SCHEDULER_MODE = $Mode
    $env:API_BIND = "127.0.0.1:$Port"
    $env:AGENT_MODE = $AgentMode
    if (-not $NoBuild) {
        $buildArguments = @('build', '--locked', '-p', 'tomorrow-api', '-p', 'tomorrow-worker')
        $features = @()
        if ($Mode -eq 'temporal') { $features += 'tomorrow-worker/temporal' }
        if ($S3) { $features += 'tomorrow-api/s3' }
        if ($features.Count -gt 0) { $buildArguments += @('--features', ($features -join ',')) }
        & cargo @buildArguments
        if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
    }
    # A long-running desktop can have a stale environment. Refresh only model variables,
    # just before launching the backends; credentials never enter files or arguments.
    foreach ($name in $modelEnvironmentNames) {
        if (-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name, 'Process'))) { continue }
        foreach ($scope in @('User','Machine')) {
            $modelValue = [Environment]::GetEnvironmentVariable($name, $scope)
            if (-not [string]::IsNullOrWhiteSpace($modelValue)) {
                [Environment]::SetEnvironmentVariable($name, $modelValue, 'Process')
                break
            }
        }
    }
    $modelValue = $null
    if ($AgentMode -eq 'pi') {
        . (Join-Path $PSScriptRoot 'Node-Tools.ps1')
        $nodeTools = Get-TomorrowNodeTools
        $agentDirectory = Join-Path $projectRoot 'services/agent'
        if (-not $NoBuild) {
            Push-Location -LiteralPath $agentDirectory
            try {
                Invoke-TomorrowPnpm -Tools $nodeTools -Arguments @('install','--frozen-lockfile')
                Invoke-TomorrowPnpm -Tools $nodeTools -Arguments @('run','build')
            } finally { Pop-Location }
        }
        $agentEntry = Join-Path $agentDirectory 'dist/server.js'
        if (-not (Test-Path -LiteralPath $agentEntry)) { throw 'Pi service is not built. Retry without -NoBuild.' }
        $tokenBytes = [byte[]]::new(32)
        [Security.Cryptography.RandomNumberGenerator]::Fill($tokenBytes)
        $env:AGENT_SERVICE_TOKEN = [Convert]::ToHexString($tokenBytes).ToLowerInvariant()
        $env:AGENT_URL = "http://127.0.0.1:$AgentPort"
        $env:AGENT_PORT = "$AgentPort"
        $env:RUST_API_URL = "http://127.0.0.1:$Port"
        $agentProcess = Start-Process -FilePath $nodeTools.Node -ArgumentList "`"$agentEntry`"" -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $projectRoot 'artifacts/logs/agent.log') `
            -RedirectStandardError (Join-Path $projectRoot 'artifacts/logs/agent-error.log')
        $startedProcesses += @{id=$agentProcess.Id;path=$nodeTools.Node;component='agent';started_at=$agentProcess.StartTime.ToUniversalTime().ToString('o')}
        $agentHealth = $null
        for ($attempt=0; $attempt -lt 60; $attempt++) {
            try { $agentHealth=Invoke-RestMethod -Uri "$env:AGENT_URL/health" -TimeoutSec 2; if ($agentHealth.ok) {break} } catch {}
            if (-not (Get-Process -Id $agentProcess.Id -ErrorAction SilentlyContinue)) { throw 'Pi startup failed. See artifacts/logs/agent-error.log.' }
            Start-Sleep -Milliseconds 250
        }
        if (-not $agentHealth.ok -or $agentHealth.harness -ne 'pi') { throw 'Pi service did not become ready.' }
        $env:AGENT_MODEL_NAME = $agentHealth.model_name
    }
    $runDirectory = Join-Path $projectRoot ('artifacts/runtime/' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $runDirectory -Force | Out-Null
    foreach ($component in @('api','worker')) {
        $binary = Join-Path $projectRoot "target/debug/tomorrow-$component.exe"
        if (-not (Test-Path -LiteralPath $binary)) { throw "Missing binary: $binary. Retry without -NoBuild." }
        $runtimeBinary = Join-Path $runDirectory "tomorrow-$component.exe"
        Copy-Item -LiteralPath $binary -Destination $runtimeBinary
        $savedModelKeys=@{}
        try {
            if ($AgentMode -eq 'pi') {
                foreach ($keyName in @('MODEL_API_KEY','DEEPSEEK_API_KEY')) {
                    $savedModelKeys[$keyName]=[Environment]::GetEnvironmentVariable($keyName,'Process')
                    # Present-but-empty also prevents dotenv from loading the model key into Rust.
                    [Environment]::SetEnvironmentVariable($keyName,'','Process')
                }
            }
            $process = Start-Process -FilePath $runtimeBinary -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $projectRoot "artifacts/logs/$component.log") `
                -RedirectStandardError (Join-Path $projectRoot "artifacts/logs/$component-error.log")
        } finally {
            foreach ($keyName in $savedModelKeys.Keys) { [Environment]::SetEnvironmentVariable($keyName,$savedModelKeys[$keyName],'Process') }
        }
        $startedProcesses += @{ id = $process.Id; path = $runtimeBinary; component=$component; started_at = $process.StartTime.ToUniversalTime().ToString('o') }
    }
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/health" -TimeoutSec 2
            if ($health.ok) { break }
        } catch { }
        Start-Sleep -Milliseconds 250
    }
    if (-not $health.ok) { throw 'API startup failed. See artifacts/logs/api-error.log.' }
    $workerReady = $false
    for ($attempt = 0; $attempt -lt 80; $attempt++) {
        $workerLog = Get-Content -LiteralPath (Join-Path $projectRoot 'artifacts/logs/worker.log') -Raw -ErrorAction SilentlyContinue
        if ($workerLog -match 'Worker 已启动') { $workerReady = $true; break }
        $workerEntry=$startedProcesses | Where-Object { $_.component -eq 'worker' } | Select-Object -First 1
        if (-not (Get-Process -Id $workerEntry.id -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $workerReady) { throw 'Worker did not report ready. See artifacts/logs/worker-error.log.' }
    foreach ($entry in $startedProcesses) {
        if (-not (Get-Process -Id $entry.id -ErrorAction SilentlyContinue)) {
            throw 'A service exited during startup. See artifacts/logs.'
        }
    }
    @{ processes = $startedProcesses; mode = $Mode; agent_mode=$AgentMode; port = $Port; agent_port=$AgentPort; started_at = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runtimeFile -Encoding utf8
    Write-Host "Tomorrow is ready: http://127.0.0.1:$Port/v1/health"
    Write-Host "Model: $($health.runtime.model_mode); database: $($health.runtime.storage_mode); scheduler: $Mode"
    Write-Host "Agent harness: $($health.runtime.agent_harness)"
    if ($health.runtime.model_name) { Write-Host "Model name: $($health.runtime.model_name)" }
    Write-Host "Android emulator API address: http://10.0.2.2:$Port"
    Write-Host "USB phone: run adb reverse tcp:$Port tcp:$Port, then set API address to http://127.0.0.1:$Port."
} catch {
    foreach ($entry in $startedProcesses) {
        $process = Get-Process -Id $entry.id -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $entry.path) { $process | Stop-Process -ErrorAction SilentlyContinue }
    }
    throw
} finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    Set-Location -LiteralPath $previousLocation
}
