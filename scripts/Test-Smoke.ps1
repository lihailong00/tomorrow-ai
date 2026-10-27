[CmdletBinding()]
param([string]$BaseUrl = 'http://127.0.0.1:8080', [ValidateRange(30,600)][int]$TaskTimeoutSeconds = 360)
$ErrorActionPreference = 'Stop'
$BaseUrl = $BaseUrl.TrimEnd('/')
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$checks = [System.Collections.Generic.List[string]]::new()
function Check([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "FAILED: $Label" }
    $checks.Add($Label)
    Write-Host "PASS $Label"
}
function Request([string]$Path, [string]$Method = 'GET', $Body = $null, [string]$Token = '') {
    $arguments = @{ Uri = "$BaseUrl/v1$Path"; Method = $Method; TimeoutSec = $(if($Path -eq '/chat'){120}else{30}) }
    if ($Token) { $arguments.Headers = @{ Authorization = "Bearer $Token" } }
    if ($null -ne $Body) { $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress)); $arguments.ContentType = 'application/json; charset=utf-8' }
    Invoke-RestMethod @arguments
}
function Expected-Status([int]$Status, [scriptblock]$Action, [string]$Label) {
    try { & $Action | Out-Null; throw "FAILED: $Label did not reject the request" }
    catch {
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq $Status) { Check $true $Label }
        else { throw }
    }
}
function Wait-Task([string]$Id, [string]$Token) {
    $taskClock=[Diagnostics.Stopwatch]::StartNew()
    while ($taskClock.Elapsed.TotalSeconds -lt $TaskTimeoutSeconds) {
        $task = Request "/tasks/$Id" -Token $Token
        if ($task.status -eq 'succeeded') { return $task }
        if ($task.status -in @('failed','cancelled','uncertain')) { throw "Task ended with $($task.status)" }
        Start-Sleep -Milliseconds 500
    }
    throw "Task did not complete within $TaskTimeoutSeconds seconds. Check worker logs."
}
$health = Request '/health'
Check $health.ok 'database health'
Expected-Status 401 { Request '/me' } 'unauthenticated request rejected'
$suffix = [Guid]::NewGuid().ToString('N')
$password = [Guid]::NewGuid().ToString('N')
$first = Request '/auth/register' 'POST' @{email="smoke-$suffix@tomorrow.local";password=$password;name='验证账号';timezone='Asia/Shanghai'}
$second = Request '/auth/register' 'POST' @{email="other-$suffix@tomorrow.local";password=$password;name='隔离账号'}
Check ($first.token -and $first.user.id -ne $second.user.id) 'independent accounts registered'
$login = Request '/auth/login' 'POST' @{email=$first.user.email;password=$password}
Check ($login.user.id -eq $first.user.id) 'password login'
$firstToken = $first.token
$secondToken = $second.token
$memory = Request '/memories' 'POST' @{title='工作偏好';content='我希望每次先看到三项最重要的安排。';kind='preference'} $firstToken
Check ($memory.version -eq 1) 'memory created'
$memory = Request "/memories/$($memory.id)" 'PATCH' @{content='我希望先看到三项最重要的安排，再看其他事项。';version=1} $firstToken
Check ($memory.version -eq 2) 'memory updated with version'
Expected-Status 409 { Request "/memories/$($memory.id)" 'PATCH' @{content='过期修改';version=1} $firstToken } 'stale memory edit rejected'
$otherMemories = Request '/memories' -Token $secondToken
Check (@($otherMemories.items).Count -eq 0) 'memories isolated between users'
$requestId = "smoke-$suffix"
$taskInput = @{title='第一份安排';instruction='根据我保存的偏好，整理今天的重点。';approval_required=$true;client_request_id=$requestId}
$task = Request '/tasks' 'POST' $taskInput $firstToken
$duplicate = Request '/tasks' 'POST' $taskInput $firstToken
Check ($task.id -eq $duplicate.id -and $task.status -eq 'waiting_approval') 'task submission idempotent and awaits approval'
Expected-Status 404 { Request "/tasks/$($task.id)" -Token $secondToken } 'task isolated between users'
Start-Sleep -Milliseconds 1000
$waiting = Request "/tasks/$($task.id)" -Token $firstToken
Check ($waiting.status -eq 'waiting_approval') 'worker leaves unapproved task untouched'
Request "/tasks/$($task.id)/approve" 'POST' @{} $firstToken | Out-Null
$completed = Wait-Task $task.id $firstToken
Check ($completed.result -and $completed.artifact_id -and $completed.progress -eq 100) 'approved task produces persisted result'
$artifact = Request "/artifacts/$($completed.artifact_id)" -Token $firstToken
Check ($artifact.task_id -eq $task.id -and $artifact.content) 'result artifact retrievable'
$notifications = Request '/notifications' -Token $firstToken
$matchingNotifications = @($notifications.items | Where-Object {$_.task_id -eq $task.id})
Check ($matchingNotifications.Count -eq 1) 'task publishes one notification'
Request "/notifications/$($matchingNotifications[0].id)/read" 'POST' @{} $firstToken | Out-Null
$notifications = Request '/notifications' -Token $firstToken
Check (@($notifications.items | Where-Object {$_.id -eq $matchingNotifications[0].id -and $_.read}).Count -eq 1) 'notification read state persisted'
$cancelled = Request '/tasks' 'POST' @{instruction='这条任务应在批准前取消';approval_required=$true} $firstToken
$cancelled = Request "/tasks/$($cancelled.id)/cancel" 'POST' @{} $firstToken
Check ($cancelled.status -eq 'cancelled') 'task cancellation persisted'
$schedule = Request '/schedules' 'POST' @{title='每日收尾';instruction='根据已有资料整理一天';frequency='daily';time='23:15';timezone='Asia/Shanghai';enabled=$true} $firstToken
Check ($schedule.enabled -and $schedule.next_run_at) 'timezone schedule created'
$schedule = Request "/schedules/$($schedule.id)" 'PATCH' @{enabled=$false} $firstToken
Check (-not $schedule.enabled) 'schedule paused'
$schedule = Request "/schedules/$($schedule.id)" 'PATCH' @{enabled=$true} $firstToken
Check $schedule.enabled 'schedule resumed'
$chatInput = @{message='我保存了什么工作偏好？';client_request_id="chat-$suffix"}
$chat = Request '/chat' 'POST' $chatInput $firstToken
$sameChat = Request '/chat' 'POST' $chatInput $firstToken
Check ($chat.message.id -eq $sameChat.message.id -and $chat.message.content) 'chat roundtrip and retry idempotency'
$messages = Request "/conversations/$($chat.conversation_id)/messages" -Token $firstToken
Check (@($messages.items).Count -eq 2) 'conversation persisted without duplicate turns'
Expected-Status 404 { Request "/conversations/$($chat.conversation_id)/messages" -Token $secondToken } 'conversation isolated between users'
$http = [Net.Http.HttpClient]::new()
try {
    $http.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $firstToken)
    $multipart = [Net.Http.MultipartFormDataContent]::new()
    $filePart = [Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes('This is an actual uploaded file.'))
    $filePart.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('text/plain')
    $multipart.Add($filePart, 'file', 'smoke-note.txt')
    $response = $http.PostAsync("$BaseUrl/v1/uploads", $multipart).GetAwaiter().GetResult()
    $response.EnsureSuccessStatusCode() | Out-Null
    $upload = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
    Check ($upload.id -and $upload.size -gt 0) 'multipart file upload stores actual bytes'
    $download = $http.GetStringAsync("$BaseUrl/v1/uploads/$($upload.id)/download").GetAwaiter().GetResult()
    Check ($download -eq 'This is an actual uploaded file.') 'authenticated download preserves content'
    Expected-Status 404 { Request "/uploads/$($upload.id)/download" -Token $secondToken } 'uploaded file isolated between users'
    Request "/uploads/$($upload.id)" 'DELETE' -Token $firstToken | Out-Null
    Expected-Status 404 { Request "/uploads/$($upload.id)/download" -Token $firstToken } 'deleted upload is no longer accessible'
} finally { $http.Dispose() }
$today = Request '/today' -Token $firstToken
Check ($today.stats.tasks_completed -ge 1 -and $today.stats.memory_count -eq 1) 'today dashboard uses saved data'
$capabilities = Request '/capabilities' -Token $firstToken
Check ($capabilities.runtime.model_mode -eq $health.runtime.model_mode) 'runtime mode disclosed consistently'
$connectors = Request '/connectors' -Token $firstToken
Check (@($connectors.items).Count -eq 3) 'all three connector statuses are available'
Check (@($connectors.items | Where-Object {$_.status -notin @('connected','not_connected','not_configured')}).Count -eq 0) 'connector status is explicit'
Request "/memories/$($memory.id)" 'DELETE' -Token $firstToken | Out-Null
$remainingMemories = Request '/memories' -Token $firstToken
Check (@($remainingMemories.items).Count -eq 0) 'memory deletion takes effect'
Request "/schedules/$($schedule.id)" 'DELETE' -Token $firstToken | Out-Null
Request '/auth/logout' 'POST' @{} $firstToken | Out-Null
Request '/auth/logout' 'POST' @{} $secondToken | Out-Null
Request '/auth/logout' 'POST' @{} $login.token | Out-Null
Expected-Status 401 { Request '/me' -Token $firstToken } 'logout revokes server session'
$reportPath = Join-Path $projectRoot 'artifacts/smoke-results.json'
New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
@{passed=$checks.Count;failed=0;checks=@($checks.ToArray());runtime=$health.runtime;tested_at=[DateTime]::UtcNow.ToString('o')} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "All $($checks.Count) checks passed. Report: $reportPath"
