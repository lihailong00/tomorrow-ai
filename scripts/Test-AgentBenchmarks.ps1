[CmdletBinding()]
param([ValidateRange(1,100)][int]$Concurrency=100,[switch]$DryRun,[string]$Only='')
$ErrorActionPreference='Stop'
$benchmarkRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$modelNames=@('MODEL_BASE_URL','MODEL_API_KEY','MODEL_NAME','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','BENCHMARK_CONCURRENCY')
$savedModelEnvironment=@{}
foreach($name in $modelNames){$savedModelEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try {
    foreach($name in ($modelNames | Where-Object {$_ -ne 'BENCHMARK_CONCURRENCY'})) {
        if(-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name,'Process'))){continue}
        foreach($scope in @('User','Machine')) {
            $benchmarkValue=[Environment]::GetEnvironmentVariable($name,$scope)
            if(-not [string]::IsNullOrWhiteSpace($benchmarkValue)){
                [Environment]::SetEnvironmentVariable($name,$benchmarkValue,'Process');break
            }
        }
    }
    $benchmarkValue=$null
    $env:BENCHMARK_CONCURRENCY="$Concurrency"
    $benchmarkArguments=@((Join-Path $benchmarkRoot 'services/agent/benchmarks/runner.mjs'))
    if($DryRun){$benchmarkArguments+='--dry-run'}
    if($Only){$benchmarkArguments+="--only=$Only"}
    & node @benchmarkArguments
    if($LASTEXITCODE -ne 0){throw 'Agent benchmark runner failed. Check the report for completed cases.'}
} finally {
    foreach($name in $savedModelEnvironment.Keys){[Environment]::SetEnvironmentVariable($name,$savedModelEnvironment[$name],'Process')}
}
