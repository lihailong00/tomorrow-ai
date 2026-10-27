[CmdletBinding()]
param([ValidateRange(0.01,10)][double]$BudgetCny=10,[ValidateRange(1,8)][int]$Limit=8,[ValidateRange(1,100)][int]$MaxTurns=80,[ValidateRange(1,50)][int]$Concurrency=50,[ValidateRange(1,8192)][int]$MaxOutputTokens=8192,[string]$Output='',[string]$Resume='',[switch]$DryRun)
$ErrorActionPreference='Stop'
$toolathlonRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolathlonNames=@('MODEL_BASE_URL','MODEL_API_KEY','MODEL_NAME','DEEPSEEK_API_KEY','DEEPSEEK_BASE_URL','DEEPSEEK_MODEL','TOMORROW_POWERSHELL')
$toolathlonSaved=@{}
foreach($name in $toolathlonNames){$toolathlonSaved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
try{
    foreach($name in ($toolathlonNames|Where-Object {$_ -ne 'TOMORROW_POWERSHELL'})){
        if(-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name,'Process'))){continue}
        foreach($scope in @('User','Machine')){
            $toolathlonValue=[Environment]::GetEnvironmentVariable($name,$scope)
            if(-not [string]::IsNullOrWhiteSpace($toolathlonValue)){[Environment]::SetEnvironmentVariable($name,$toolathlonValue,'Process');break}
        }
    }
    $toolathlonValue=$null
    $env:TOMORROW_POWERSHELL=(Get-Process -Id $PID).Path
    $toolathlonArgs=@((Join-Path $toolathlonRoot 'services/agent/toolathlon/run.mjs'),"--budget=$BudgetCny","--limit=$Limit","--turns=$MaxTurns","--concurrency=$Concurrency","--output-tokens=$MaxOutputTokens")
    if($Output){$toolathlonArgs+="--output=$Output"}
    if($Resume){$toolathlonArgs+="--resume=$Resume"}
    if($DryRun){$toolathlonArgs+='--dry-run'}
    & node @toolathlonArgs
    if($LASTEXITCODE -ne 0){throw 'Toolathlon runner failed. Check artifacts/toolathlon for completed accounting and diagnostics.'}
}finally{
    foreach($name in $toolathlonSaved.Keys){[Environment]::SetEnvironmentVariable($name,$toolathlonSaved[$name],'Process')}
}
