[CmdletBinding()]
param(
    [string]$BindAddress = '127.0.0.1',
    [ValidateRange(1024,65535)][int]$Port = 18080,
    [ValidateRange(1024,65535)][int]$AgentPort = 18090,
    [ValidateSet('pi','dsh')][string]$Harness = 'pi',
    [switch]$NoBuild,
    [switch]$Compare
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$ip = [Net.IPAddress]::Parse($BindAddress)
$o = $ip.GetAddressBytes()
$private = $o.Length -eq 4 -and ($o[0] -eq 127 -or $o[0] -eq 10 -or
    ($o[0] -eq 172 -and $o[1] -ge 16 -and $o[1] -le 31) -or ($o[0] -eq 192 -and $o[1] -eq 168))
if (-not $private -or $Port -eq $AgentPort) { throw 'Use a loopback or private LAN IPv4 and separate ports.' }
$bind = "$($ip.IPAddressToString):$Port"
$base = "http://$bind"
$apiLocal = "http://127.0.0.1:$Port"
$agentUrl = "http://127.0.0.1:$AgentPort"
$run = Join-Path $repo ('artifacts/tencent-docs-debug/' + [Guid]::NewGuid().ToString('N'))
$agentPath = Join-Path $repo 'services/agent/dist/server.js'
$apiPath = Join-Path $repo 'target/debug/tomorrow-api.exe'
$saved = @{}
$started = @()
$ready = $false
function Set-DebugEnv([hashtable]$Values) {
    foreach ($item in $Values.GetEnumerator()) {
        if (-not $saved.ContainsKey($item.Key)) { $saved[$item.Key] = [Environment]::GetEnvironmentVariable($item.Key, 'Process') }
        [Environment]::SetEnvironmentVariable($item.Key, $item.Value, 'Process')
    }
}
function New-DebugSecret {
    $bytes = [byte[]]::new(32)
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToHexString($bytes).ToLowerInvariant()
}
function Wait-DebugHealth([string]$Uri, $Process) {
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.Elapsed.TotalSeconds -lt 35) {
        if ($Process.HasExited) { throw "Debug process exited. See logs in $run." }
        try {
            $result = Invoke-RestMethod -Uri $Uri -TimeoutSec 2
            if ($result.ok) { return $result }
        } catch { }
        Start-Sleep -Milliseconds 300
    }
    throw "Debug service startup timed out. See logs in $run."
}
function Start-DebugProcess([string]$Path, [string]$Name, [string[]]$Arguments) {
    $parameters = @{
        FilePath=$Path; WorkingDirectory=$run; WindowStyle='Hidden'; PassThru=$true
        RedirectStandardOutput=(Join-Path $run "$Name.log")
        RedirectStandardError=(Join-Path $run "$Name-error.log")
    }
    if ($Arguments.Count -gt 0) { $parameters.ArgumentList=$Arguments }
    Start-Process @parameters
}
Push-Location -LiteralPath $repo
try {
    if (-not $NoBuild) {
        & cargo build --locked -p tomorrow-api
        if ($LASTEXITCODE -ne 0) { throw 'Rust build failed.' }
        & (Join-Path $repo 'services/agent/node_modules/.bin/tsc.cmd') -p (Join-Path $repo 'services/agent/tsconfig.json')
        if ($LASTEXITCODE -ne 0) { throw 'Agent build failed.' }
    }
    if (-not (Test-Path -LiteralPath $apiPath) -or -not (Test-Path -LiteralPath $agentPath)) { throw 'Build the Rust API and Agent before using -NoBuild.' }
    foreach ($portToCheck in @($Port,$AgentPort)) {
        if (Get-NetTCPConnection -LocalPort $portToCheck -State Listen -ErrorAction SilentlyContinue) { throw "Port $portToCheck is already in use." }
    }
    New-Item -ItemType Directory -Path $run | Out-Null
    $node = (Get-Command node -ErrorAction Stop).Source
    $email = 'qinghe@tada-debug.invalid'
    $password = (New-DebugSecret).Substring(0,24)
    foreach ($name in @('MODEL_BASE_URL','MODEL_API_KEY','MODEL_NAME','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL')) {
        if ([Environment]::GetEnvironmentVariable($name, 'Process')) { continue }
        foreach ($scope in @('User','Machine')) {
            $value = [Environment]::GetEnvironmentVariable($name,$scope)
            if ($value) { Set-DebugEnv @{$name=$value}; break }
        }
    }
    Set-DebugEnv @{
        APP_ENV='local'; INSTANCE_MODE='self_hosted'; INSTANCE_NAME='妥啦 · 腾讯文档调试'
        INSTANCE_PUBLIC_URL=''; REGISTRATION_POLICY='closed'; EMAIL_PASSWORD_ENABLED='true'
        PHONE_PASSWORD_ENABLED='false'; PHONE_AUTH_MODE='disabled'; DEEPSEEK_WEB_ENABLED='false'
        AGENT_SERVICE_TOKEN=(New-DebugSecret); AGENT_MODE=$Harness; AGENT_URL=$agentUrl
        AGENT_PORT="$AgentPort"; RUST_API_URL=$apiLocal; TADA_RUNTIME_CONFIG='disabled'
        AGENT_TOOL_SEARCH_ENABLED='true'; AGENT_QUERY_REWRITE_ENABLED='true'
        TADA_TENCENT_DOCS_FIXTURE_EMAIL=''; TADA_TENCENT_DOCS_FIXTURE_PASSWORD=''
    }
    $agent = Start-DebugProcess $node 'agent' @('"' + $agentPath + '"')
    $started += $agent
    $health = Wait-DebugHealth "$agentUrl/health" $agent
    if (-not $health.configured) { throw 'Configure a DeepSeek or compatible model for the sandbox.' }
    $proxy = $null
    if ($o[0] -ne 127) {
        $proxyPath = Join-Path $repo 'services/agent/benchmarks/tencent-docs-lan.mjs'
        $proxy = Start-DebugProcess $node 'lan' @('"' + $proxyPath + '"', $ip.IPAddressToString, "$Port")
        $started += $proxy
    }
    Set-DebugEnv @{
        DEEPSEEK_API_KEY=''; MODEL_API_KEY=''; API_BIND=("127.0.0.1:"+$Port); AGENT_MODEL_NAME=$health.model_name
        DATABASE_URL=('sqlite:' + (Join-Path $run 'debug.db').Replace('\','/'))
        UPLOAD_DIR=(Join-Path $run 'uploads'); TADA_CONFIG_DIR=(Join-Path $run 'config')
        TADA_CONFIG_MASTER_KEY=(New-DebugSecret); CONNECTOR_ENCRYPTION_KEY=''
        TADA_TENCENT_DOCS_FIXTURE_EMAIL=$email; TADA_TENCENT_DOCS_FIXTURE_PASSWORD=$password
    }
    $runtimeApi = Join-Path $run 'tomorrow-api.exe'
    Copy-Item -LiteralPath $apiPath -Destination $runtimeApi
    $api = Start-DebugProcess $runtimeApi 'api' @()
    $started += $api
    $null = Wait-DebugHealth "$apiLocal/v1/health" $api
    if ($proxy) { $null = Wait-DebugHealth "$base/v1/health" $proxy }
    $loginBody = @{email=$email;password=$password} | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Uri "$base/v1/auth/login" -Method Post -ContentType 'application/json' -Body $loginBody -TimeoutSec 12
    $connection = Invoke-RestMethod -Uri "$base/v1/personal-mcp" -Headers @{Authorization="Bearer $($login.token)"} -TimeoutSec 8
    if (-not ($connection.items | Where-Object { $_.id -eq 'tencent_docs' -and $_.simulated })) { throw 'The seeded account did not receive the simulated connection.' }
    $ready = $true
    [pscustomobject]@{url=$base;email=$email;password=$password;model=$health.model_name;harness=$Harness;api_pid=$api.Id;agent_pid=$agent.Id;lan_pid=$proxy.Id;directory=$run} | ConvertTo-Json -Compress
    if ($Compare) {
        Set-DebugEnv @{TADA_DEBUG_BASE_URL=$base}
        & $node (Join-Path $repo 'services/agent/benchmarks/tencent-docs-debug.mjs') (Join-Path $run 'comparison.json')
        if ($LASTEXITCODE -ne 0) { throw "Comparison did not fully pass. See $run." }
    }
} finally {
    if (-not $ready) {
        foreach ($process in $started) { if (-not $process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue } }
    }
    Set-DebugEnv $saved
    Pop-Location
}
