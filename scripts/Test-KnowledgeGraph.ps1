param(
    [string]$ApiUrl = 'http://127.0.0.1:18080',
    [switch]$Live
)
$ErrorActionPreference = 'Stop'
if (-not $Live) { throw 'This test uses the real configured model. Run with -Live against the isolated knowledge-demo instance.' }
$uri = [uri]$ApiUrl
if ($uri.Host -notin @('localhost','127.0.0.1') -or $uri.Port -ne 18080) {
    throw 'Use the isolated local knowledge-demo instance on port 18080.'
}
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'artifacts/knowledge-graph'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$token = $null
$sources = [System.Collections.Generic.List[object]]::new()
$checks = [System.Collections.Generic.List[object]]::new()
$runs = [System.Collections.Generic.List[object]]::new()
function Call-Api($method,$path,$body=$null) {
    $parameters = @{ Uri="$ApiUrl$path"; Method=$method; TimeoutSec=140; ContentType='application/json; charset=utf-8' }
    if ($token) { $parameters.Headers=@{Authorization="Bearer $token"} }
    if ($null -ne $body) { $parameters.Body=[System.Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 30 -Compress)) }
    Invoke-RestMethod @parameters
}
function Check($name,$condition) {
    $checks.Add(@{name=$name;passed=[bool]$condition})
    if (-not $condition) { throw "Verification failed: $name" }
}
try {
    $id=[guid]::NewGuid().ToString('N')
    $session=Call-Api POST '/v1/auth/register' @{email="graph-$id@local.test";password=([guid]::NewGuid().ToString('N'));name='图记忆验证';timezone='Asia/Shanghai'}
    $token=$session.token
    $proposal=Call-Api POST '/v1/memories' @{title='Tomorrow 早期讨论';kind='project';content='2026-09-03：王伟提议 Tomorrow 采用方案V2。';source='虚构验证数据'}
    $sources.Add($proposal)
    $decision=Call-Api POST '/v1/memories' @{title='Tomorrow 方案确认';kind='project';content="2026-09-21：王伟确认 Tomorrow 采用方案V3。`n2026-09-21：方案V3 的 API 使用 Rust；方案V3 的 API 使用 Axum。`n2026-09-21：林负责方案V3 的部署。";source='虚构验证数据'}
    $sources.Add($decision)
    $prompt="请把我已保存的这两条记忆建立实体关系图索引，范围使用原文的 Tomorrow。记忆编号分别为 $($proposal.id) 和 $($decision.id)。请先读取原文，再提取实体、关系、提议或确认状态和原文明示的日期；每条记忆分别索引，证据必须完整保留相关句子，不创建其他记忆。"
    $indexed=Call-Api POST '/v1/chat' @{message=$prompt;client_request_id="graph-index-$id"}
    $run=Call-Api GET "/v1/agent-runs/$($indexed.agent_run_id)"
    $runs.Add($run)
    $writes=@($run.operations | Where-Object tool -eq 'index_memory_graph')
    Check 'real Pi indexed both source memories' ($writes.Count -eq 2)
    $graph=Call-Api GET '/v1/knowledge-graph/search?query=%E7%8E%8B%E4%BC%9F&scope=Tomorrow&limit=30'
    $all=@($graph.facts)+@($graph.related_facts)
    Check 'proposal is preserved as proposed' (@($all | Where-Object { $_.relation -eq 'PROPOSED' -and $_.status -eq 'proposed' }).Count -gt 0)
    Check 'confirmation is preserved as confirmed' (@($all | Where-Object { $_.relation -eq 'CONFIRMED' -and $_.status -eq 'confirmed' }).Count -gt 0)
    Check 'graph traversal reaches Rust' (@($all | Where-Object { $_.object.name -eq 'Rust' }).Count -gt 0)
    Check 'every fact has a source and exact quote' (@($all | Where-Object { -not $_.source.id -or -not $_.source.quote }).Count -eq 0)
    $answered=Call-Api POST '/v1/chat' @{message='请实际查询已建立的关系图：在2026-09-01至2026-10-01期间，王伟确认了Tomorrow哪个方案？API使用什么技术，谁负责部署？请区分早期提议和已确认方案，指出来源记忆。';client_request_id="graph-query-$id"}
    $answerRun=Call-Api GET "/v1/agent-runs/$($answered.agent_run_id)"
    $runs.Add($answerRun)
    Check 'answer used the graph tool' (@($answerRun.events | Where-Object {$_.kind -eq 'tool_start' -and $_.body.tool -eq 'search_knowledge_graph'}).Count -gt 0)
    Check 'answer includes final version and API technologies' ($answered.message.content -match 'V3' -and $answered.message.content -match 'Rust' -and $answered.message.content -match 'Axum')
    $null=Call-Api PATCH "/v1/memories/$($decision.id)" @{version=$decision.version;content=$decision.content.Replace('Rust','Go')}
    $stale=Call-Api GET '/v1/knowledge-graph/search?query=Rust&scope=Tomorrow'
    Check 'source update immediately hides obsolete facts' (@($stale.facts).Count -eq 0)
    $report=@{verified_at=[DateTime]::UtcNow.ToString('o');model='configured Pi model';checks=$checks;index_reply=$indexed.message.content;answer=$answered.message.content;graph=$graph;runs=$runs;pricing='Token usage only; no estimated currency charge';sources=$sources}
    $report | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath (Join-Path $out 'live-verification.json') -Encoding utf8
    [pscustomobject]@{passed=$checks.Count;model_requests=(@($runs | ForEach-Object {$_.usage.model_requests}) | Measure-Object -Sum).Sum;total_tokens=(@($runs | ForEach-Object {$_.usage.total_tokens}) | Measure-Object -Sum).Sum;report='artifacts/knowledge-graph/live-verification.json'} | ConvertTo-Json
} finally {
    if ($token) {
        foreach ($source in $sources) { try { $null=Call-Api DELETE "/v1/memories/$($source.id)" } catch {} }
        try { $null=Call-Api POST '/v1/auth/logout' @{} } catch {}
    }
}
