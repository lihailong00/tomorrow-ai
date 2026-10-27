[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Prepare', 'Evaluate')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [string]$ContainerName,
    [Parameter(Mandatory = $true)]
    [string]$Task,
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,
    [Parameter(Mandatory = $true)]
    [string]$PrivateRoot,
    [int]$GatewayPort = 18761,
    [int]$MaxSteps = 80,
    [int]$AgentExitCode = 0,
    [string]$DockerContext = 'desktop-linux'
)

$ErrorActionPreference = 'Stop'
$taskPython = (Get-Command python -ErrorAction Stop).Source
& $taskPython (Join-Path $PSScriptRoot 'toolathlon_task.py') $Action.ToLowerInvariant() `
    --container $ContainerName --task $Task --output-root $OutputRoot `
    --private-root $PrivateRoot --gateway-port $GatewayPort --max-steps $MaxSteps `
    --agent-exit-code $AgentExitCode --docker-context $DockerContext
exit $LASTEXITCODE
