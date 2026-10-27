[CmdletBinding()]
param([string]$BaseUrl='http://127.0.0.1:8080')
$ErrorActionPreference='Stop'
$BaseUrl=$BaseUrl.TrimEnd('/')
$projectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$reportPath=Join-Path $projectRoot 'artifacts/pi-live-verification.json'
$cases=[Collections.Generic.List[object]]::new()
$traces=[Collections.Generic.List[object]]::new()
$requests=[Collections.Generic.List[object]]::new()
$suffix=[Guid]::NewGuid().ToString('N')
$marker='PI-'+$suffix.Substring(0,10)
$token='';$otherToken='';$loginToken=''
function Api([string]$Path,[string]$Method='GET',$Body=$null,[string]$AuthToken=$token) {
    $options=@{Uri="$BaseUrl/v1$Path";Method=$Method;TimeoutSec=120}
    if($AuthToken){$options.Headers=@{Authorization="Bearer $AuthToken"}}
    if($null -ne $Body){$options.Body=[Text.Encoding]::UTF8.GetBytes(($Body|ConvertTo-Json -Depth 20 -Compress));$options.ContentType='application/json; charset=utf-8'}
    Invoke-RestMethod @options
}
function Require([bool]$Condition,[string]$Message){if(-not $Condition){throw $Message}}
function Save-Report {
    @{tested_at=[DateTime]::UtcNow.ToString('o');runtime=$health.runtime;harness_version='1.4.0';
      model_calls='real DeepSeek, token usage comes from Pi traces; billed price unavailable';
      passed=@($cases.ToArray()|Where-Object status -eq 'passed').Count;failed=@($cases.ToArray()|Where-Object status -eq 'failed').Count;
      cases=$cases.ToArray();requests=$requests.ToArray();traces=$traces.ToArray()}|
      ConvertTo-Json -Depth 35|Set-Content -LiteralPath $reportPath -Encoding utf8
}
function Case([string]$Id,[string]$Name,[scriptblock]$Action) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    try {& $Action; $cases.Add(@{id=$Id;name=$Name;status='passed';duration_ms=$clock.ElapsedMilliseconds});Write-Host "PASS $Id $Name"}
    catch {$cases.Add(@{id=$Id;name=$Name;status='failed';duration_ms=$clock.ElapsedMilliseconds;error=$_.Exception.Message});Write-Host "FAIL $Id $Name : $($_.Exception.Message)"}
    Save-Report
}
function Chat([string]$Prompt,[string]$Conversation='',[string]$RequestId='') {
    if(-not $RequestId){$RequestId=[Guid]::NewGuid().ToString('N')}
    $body=@{message=$Prompt;client_request_id=$RequestId}
    if($Conversation){$body.conversation_id=$Conversation}
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $reply=Api '/chat' 'POST' $body
    $requests.Add(@{prompt=$Prompt;reply=$reply.message.content;conversation_id=$reply.conversation_id;run_id=$reply.agent_run_id;duration_ms=$watch.ElapsedMilliseconds})
    if($reply.agent_run_id){$traces.Add((Api "/agent-runs/$($reply.agent_run_id)"))}
    $reply
}
function Wait-Task([string]$Id) {
    $clock=[Diagnostics.Stopwatch]::StartNew()
    while($clock.Elapsed.TotalSeconds -lt 115){
        $value=Api "/tasks/$Id"
        if($value.status -eq 'succeeded'){return $value}
        if($value.status -in @('failed','cancelled','uncertain')){throw "Task status: $($value.status)"}
        Start-Sleep -Milliseconds 500
    }
    throw 'Background task did not complete within 115 seconds'
}

$health=Api '/health' -AuthToken ''
Require ($health.runtime.agent_harness -eq 'pi') 'Pi is not enabled'
$password=[Guid]::NewGuid().ToString('N')
$email="pi-live-$suffix@tomorrow.local"
$first=Api '/auth/register' 'POST' @{email=$email;password=$password;name='Pi验证';timezone='Asia/Shanghai'} -AuthToken ''
$second=Api '/auth/register' 'POST' @{email="pi-other-$suffix@tomorrow.local";password=$password;name='隔离验证';timezone='Asia/Shanghai'} -AuthToken ''
$token=$first.token;$otherToken=$second.token
$createPrompt="请实际完成这三项：1. 记住事实：测试项目口令是 $marker。2. 创建一个名为‘$marker 项目安排’的后台任务，要求根据已保存的项目口令写一句项目介绍，任务等待我在详情页确认。3. 保存名为‘$marker 每日整理’的每天08:35的计划草稿，使用上海时区，内容为整理当天已有资料，暂不启用。完成后简短告诉我真实保存状态。"
$createRequest="pi-create-$suffix"
try {
    Case 'PI01' '真实模型通过 Pi 创建记忆、待审批任务和计划草稿' {
        $script:created=Chat $createPrompt -RequestId $createRequest
        $script:memories=Api '/memories';$script:tasks=Api '/tasks';$script:plans=Api '/schedules'
        Require (@($memories.items).Count -eq 1 -and $memories.items[0].content.Contains($marker)) 'Memory was not really saved'
        Require (@($tasks.items).Count -eq 1 -and $tasks.items[0].status -eq 'waiting_approval') 'Task is missing or self-approved'
        Require (@($plans.items).Count -eq 1 -and -not $plans.items[0].enabled -and $plans.items[0].time -eq '08:35' -and $plans.items[0].timezone -eq 'Asia/Shanghai') 'Schedule draft parameters differ'
        $script:taskId=$tasks.items[0].id;$script:planId=$plans.items[0].id
        $trace=Api "/agent-runs/$($created.agent_run_id)"
        Require ($trace.status -eq 'succeeded' -and @($trace.operations).Count -eq 3) 'Expected three committed tool effects'
        Require (@($trace.events|Where-Object kind -eq 'tool_end').Count -ge 3) 'Pi tool events are missing'
    }
    Case 'PI02' '重复提交同一条聊天不重复创建资源' {
        $again=Chat $createPrompt -RequestId $createRequest
        Require ($again.message.id -eq $created.message.id) 'Chat response was not cached'
        Require (@((Api '/memories').items).Count -eq 1 -and @((Api '/tasks').items).Count -eq 1 -and @((Api '/schedules').items).Count -eq 1) 'Retry duplicated business effects'
    }
    Case 'PI03' '新建对话通过工具查询跨会话记忆' {
        $reply=Chat '我之前保存的测试项目口令是什么？请先查询记忆，直接回答口令。'
        Require ($reply.message.content.Contains($marker)) 'Cross-conversation memory was not used'
        $trace=Api "/agent-runs/$($reply.agent_run_id)"
        Require (@($trace.events|Where-Object {$_.kind -eq 'tool_start' -and $_.body.tool -eq 'list_memories'}).Count -ge 1) 'Model did not actually query memory'
    }
    Case 'PI04' '审批前 Worker 不执行，审批后经 Pi 生成持久成果' {
        Start-Sleep -Milliseconds 2300
        Require ((Api "/tasks/$taskId").status -eq 'waiting_approval') 'Unapproved task executed'
        Api "/tasks/$taskId/approve" 'POST' @{} | Out-Null
        $done=Wait-Task $taskId
        $artifact=Api "/artifacts/$($done.artifact_id)"
        Require ($done.model_mode -eq 'llm' -and $artifact.content.Contains($marker)) 'Pi background result did not use saved data'
        $notifications=Api '/notifications'
        Require (@($notifications.items|Where-Object task_id -eq $taskId).Count -eq 1) 'Expected one completion notification'
        $runs=Api '/agent-runs'
        $background=@($runs.items|Where-Object scope -eq 'task')
        Require ($background.Count -eq 1 -and $background[0].status -eq 'succeeded') 'Background task bypassed Pi'
        $traces.Add((Api "/agent-runs/$($background[0].id)"))
    }
    Case 'PI05' '修改记忆后新对话读取最新版本' {
        $script:newMarker="$marker-UPDATED"
        Chat "请查询并修改我保存的测试项目口令，将它更新为 $newMarker，替换原有那条记忆，不要新增重复记录。" | Out-Null
        $items=(Api '/memories').items
        Require (@($items).Count -eq 1 -and $items[0].version -eq 2 -and $items[0].content.Contains($newMarker)) 'Memory was not updated in place'
        $reply=Chat '查询记忆，现在的测试项目口令是什么？'
        Require ($reply.message.content.Contains($newMarker)) 'New conversation used stale memory'
    }
    Case 'PI06' '在聊天中暂停已启用的计划' {
        Api "/schedules/$planId" 'PATCH' @{enabled=$true} | Out-Null
        Chat "请查询我的计划，暂停名为‘$marker 每日整理’的计划。" | Out-Null
        Require (-not @((Api '/schedules').items|Where-Object id -eq $planId)[0].enabled) 'Schedule did not pause'
    }
    Case 'PI07' '模型通过附件工具读取真实上传文本' {
        $http=[Net.Http.HttpClient]::new()
        try {
            $http.DefaultRequestHeaders.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$token)
            $form=[Net.Http.MultipartFormDataContent]::new()
            $part=[Net.Http.ByteArrayContent]::new([Text.Encoding]::UTF8.GetBytes("项目：银河；预算：7300元；截止：2026-11-09。资料编号：FILE-$marker"))
            $part.Headers.ContentType=[Net.Http.Headers.MediaTypeHeaderValue]::new('text/plain');$form.Add($part,'file','pi-project.txt')
            $response=$http.PostAsync("$BaseUrl/v1/uploads",$form).GetAwaiter().GetResult();$response.EnsureSuccessStatusCode()|Out-Null
            $script:upload=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()|ConvertFrom-Json
        } finally {$http.Dispose()}
        $reply=Chat "请使用附件读取工具读取文件 id=$($upload.id)，告诉我项目预算和截止日期。"
        Require ($reply.message.content -match '7[,]?300' -and $reply.message.content -match '11[-月/]0?9') 'Attachment facts differ'
        $trace=Api "/agent-runs/$($reply.agent_run_id)"
        Require (@($trace.events|Where-Object {$_.kind -eq 'tool_start' -and $_.body.tool -eq 'read_attachment'}).Count -eq 1) 'Attachment tool did not run'
    }
    Case 'PI08' '通过对话删除记忆且新对话无法读取已删除事实' {
        Chat '请查询并删除我保存的那条测试项目口令记忆。' | Out-Null
        Require (@((Api '/memories').items).Count -eq 0) 'Memory was not deleted'
        $reply=Chat '请查询记忆，告诉我之前保存的测试项目口令。不知道就说不知道。'
        Require (-not $reply.message.content.Contains($marker)) 'Deleted memory leaked into a new conversation'
    }
    Case 'PI09' '不同用户不能查看执行记录和任务结果' {
        foreach($path in @("/agent-runs/$($created.agent_run_id)","/tasks/$taskId")) {
            try {Api $path -AuthToken $otherToken|Out-Null;throw 'Cross-user resource was exposed'}
            catch {if(-not $_.Exception.Response -or [int]$_.Exception.Response.StatusCode -ne 404){throw}}
        }
        Require (@((Api '/agent-runs' -AuthToken $otherToken).items).Count -eq 0) 'Agent run listing leaked another user'
    }
    Case 'PI10' '重新登录后业务结果与执行记录仍可查询' {
        $session=Api '/auth/login' 'POST' @{email=$email;password=$password} -AuthToken ''; $script:loginToken=$session.token
        Require ((Api "/tasks/$taskId" -AuthToken $loginToken).status -eq 'succeeded') 'Completed task disappeared'
        $trace=Api "/agent-runs/$($created.agent_run_id)" -AuthToken $loginToken
        Require ($trace.usage.model_requests -ge 2 -and $trace.usage.total_tokens -gt 0) 'Real Pi usage is absent'
        $encoded=$trace|ConvertTo-Json -Depth 30
        Require ($encoded -notmatch 'run_token|token_hash|AGENT_SERVICE_TOKEN|DEEPSEEK_API_KEY') 'Internal credential fields exposed'
    }
} finally {
    if($token){
        foreach($plan in @((Api '/schedules').items)){Api "/schedules/$($plan.id)" 'DELETE'|Out-Null}
        if($upload){Api "/uploads/$($upload.id)" 'DELETE'|Out-Null}
        foreach($sessionToken in @($token,$otherToken,$loginToken)){if($sessionToken){try{Api '/auth/logout' 'POST' @{} -AuthToken $sessionToken|Out-Null}catch{}}}
    }
    Save-Report
}
Write-Host "Report: $reportPath"
if(@($cases.ToArray()|Where-Object status -eq 'failed').Count -gt 0){throw 'Pi live verification has failing cases. See report.'}
