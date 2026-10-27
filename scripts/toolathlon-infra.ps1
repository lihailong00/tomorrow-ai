[CmdletBinding()]
param(
    [ValidateSet('Status', 'Pull', 'Start', 'Stop')]
    [string]$Action = 'Status',
    [string]$Task = 'excel-data-transformation',
    [string]$ContainerName = '',
    [int]$GatewayPort = 18761,
    [string]$OutputRoot = '',
    [string]$DockerContext = 'desktop-linux',
    [string]$Image = 'lockon0927/toolathlon-task-image:1016beta'
)

$ErrorActionPreference = 'Stop'
$taskRepoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskOfficialRoot = Join-Path $taskRepoRoot '.tools\toolathlon'
if (-not $OutputRoot) {
    $OutputRoot = Join-Path $taskRepoRoot 'artifacts\toolathlon'
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)

function Invoke-TaskDocker {
    # A simple function preserves Docker flags such as -p instead of binding
    # them to PowerShell common parameters.
    & docker --context $DockerContext @args
    if ($LASTEXITCODE -ne 0) {
        throw "Docker operation failed with exit code $LASTEXITCODE."
    }
}

if ($Action -eq 'Status') {
    Invoke-TaskDocker version --format '{{.Server.Version}}'
    Invoke-TaskDocker ps --format '{{.Names}} {{.Status}} {{.Ports}}'
    Invoke-TaskDocker image ls $Image --format '{{.Repository}}:{{.Tag}} {{.Size}}'
    exit 0
}

if ($Action -eq 'Pull') {
    Invoke-TaskDocker pull $Image
    exit 0
}

if ($Action -eq 'Stop') {
    if ($ContainerName -notmatch '^tomorrow-toolathlon-[a-z0-9-]+$') {
        throw 'Only a named tomorrow-toolathlon-* test container can be removed.'
    }
    Invoke-TaskDocker rm --force $ContainerName
    exit 0
}

if ($Task -notmatch '^[a-z0-9][a-z0-9-]+$') {
    throw 'Task must be a safe task name under tasks/finalpool.'
}
if ($GatewayPort -lt 1024 -or $GatewayPort -gt 65535) {
    throw 'GatewayPort must be between 1024 and 65535.'
}
$taskSource = Join-Path $taskOfficialRoot "tasks\finalpool\$Task"
if (-not (Test-Path -LiteralPath $taskSource -PathType Container)) {
    throw "Official task source was not found: $taskSource"
}
if (-not $ContainerName) {
    $ContainerName = 'tomorrow-toolathlon-' + $Task + '-' + (Get-Date -Format 'yyyyMMddHHmmss')
}
if ($ContainerName -notmatch '^tomorrow-toolathlon-[a-z0-9-]+$') {
    throw 'ContainerName must use the tomorrow-toolathlon- prefix.'
}
$taskOutput = Join-Path $OutputRoot $Task
New-Item -ItemType Directory -Force -Path $taskOutput | Out-Null

# The model runs on the Windows host. No credential environment variables,
# personal-account auth directory, Docker socket, or unrelated host folders
# are passed into the test container. Bridge port publishing supports older
# Docker Desktop releases that do not expose host networking on Windows.
Invoke-TaskDocker run -d --name $ContainerName `
    -p "127.0.0.1:${GatewayPort}:${GatewayPort}" `
    --mount "type=bind,source=$taskOutput,target=/workspace/dumps" `
    -w /workspace $Image sleep 14400 | Out-Null

try {
    foreach ($taskItem in @('configs', 'scripts', 'utils')) {
        Invoke-TaskDocker exec $ContainerName mkdir -p "/workspace/$taskItem"
        # Fresh official source is copied; never copy .mcp-auth from the host.
        if ($taskItem -eq 'configs') {
            foreach ($taskConfigItem in Get-ChildItem -LiteralPath (Join-Path $taskOfficialRoot 'configs') -Force) {
                if ($taskConfigItem.Name -eq '.mcp-auth') { continue }
                Invoke-TaskDocker cp $taskConfigItem.FullName "${ContainerName}:/workspace/configs/"
            }
        } else {
            $taskCopySource = (Join-Path $taskOfficialRoot $taskItem) + '\.'
            Invoke-TaskDocker cp $taskCopySource "${ContainerName}:/workspace/$taskItem/"
        }
    }
    Invoke-TaskDocker exec $ContainerName mkdir -p /workspace/tasks/finalpool
    Invoke-TaskDocker cp $taskSource "${ContainerName}:/workspace/tasks/finalpool/"
    Invoke-TaskDocker cp (Join-Path $taskOfficialRoot 'main.py') "${ContainerName}:/workspace/main.py"
    $taskCheckInstall = Join-Path $taskOfficialRoot 'global_preparation\check_installation.py'
    if (Test-Path -LiteralPath $taskCheckInstall) {
        Invoke-TaskDocker exec $ContainerName mkdir -p /workspace/global_preparation
        Invoke-TaskDocker cp $taskCheckInstall "${ContainerName}:/workspace/global_preparation/check_installation.py"
    }
    Invoke-TaskDocker exec $ContainerName uv run --no-sync python -c 'import sys; print(sys.version)'
    [PSCustomObject]@{
        container = $ContainerName
        task = "finalpool/$Task"
        image = $Image
        output = $taskOutput
        gateway = "http://127.0.0.1:$GatewayPort"
        authMounted = $false
        dockerSocketMounted = $false
        modelCredentialsForwarded = $false
    } | ConvertTo-Json
} catch {
    Write-Warning "Preparation failed. Container retained for inspection: $ContainerName"
    throw
}
