pub const PAGE: &str = r##"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>导入 AI 对话 · 妥啦</title>
<style>body{margin:0;background:linear-gradient(135deg,#f7f4f5,#eaf1ff);color:#30394d;font:16px/1.7 system-ui,sans-serif}main{max-width:840px;margin:48px auto;padding:24px}h1{font-size:32px;margin-bottom:4px}p{color:#748097}.card{padding:28px;background:#ffffffdc;border:1px solid white;border-radius:28px;margin:20px 0}input,select,button{font:inherit;border:1px solid #dee4ef;border-radius:14px;padding:12px;box-sizing:border-box}input{max-width:100%}button{background:#4269c7;color:white;cursor:pointer}button.secondary{background:#eef3ff;color:#4269c7}button:disabled{opacity:.5;cursor:wait}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.muted{font-size:14px;color:#748097}label{display:block;margin:12px 0}#notice{white-space:pre-wrap;color:#4269c7}article{border-top:1px solid #e9edf5;padding:16px 0}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}[hidden]{display:none!important}</style>
<main><span>妥啦 · 让过去的对话接着帮你</span><h1>导入其他 AI 对话</h1><p>支持 ChatGPT、Claude、DeepSeek 的官方 ZIP / JSON 导出文件。</p>
<section id="login" class="card"><h2>登录妥啦账号</h2><p>与手机使用同一个账号。登录凭据只用于妥啦服务，不需要其他 AI 平台的密码。</p><p id="loginStatus" class="muted">正在检查此服务器支持的登录方式…</p><form id="loginForm"><label id="methodLabel" hidden>登录方式<select id="authMethod"></select></label><label><span id="accountLabel">账号</span><input id="account" autocomplete="username" required maxlength="254"></label><label>密码<input id="password" type="password" autocomplete="current-password" required></label><button id="loginSubmit" disabled>登录</button></form><button id="retryLogin" type="button" class="secondary" hidden>重新检查登录方式</button></section>
<section id="import" class="card" hidden><div class="row"><h2>选择导出文件</h2><button id="logout" class="secondary">退出</button></div><label>来源<select id="provider"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option><option value="deepseek">DeepSeek</option></select></label><p id="guide"></p><input id="file" type="file" accept=".zip,.json,application/json,application/zip"><p class="muted">单文件最多 25 MB。ZIP 无需解压；大包可解压后分批选择 conversations*.json。原始压缩包不长期保存。文件上传后先预览，确认后才供助手检索；长期记忆另行确认。</p><button id="upload">上传并预览</button><p class="muted">下载链接可能需要原平台登录。请先在原平台下载文件，再在这里选择；这页不会获取你的其他平台登录凭据。</p></section>
<section id="pending" class="card" hidden><h2>待确认的导入</h2><p id="pendingStatus" class="muted"></p><div id="pendingItems"></div><button id="refreshPending" type="button" class="secondary">刷新待确认列表</button></section>
<section id="preview" class="card" hidden><h2>确认导入范围</h2><p id="summary"></p><p id="warnings" class="muted"></p><div class="row"><button id="commit">确认导入全部</button><button id="cancel" class="secondary">取消并删除预览</button></div><div id="items"></div><button id="more" class="secondary" hidden>查看更多</button></section><p id="notice" role="status"></p><p class="muted">导入完成后，在手机「能力 → 导入 AI 对话」中查看、搜索或删除。刷新后登录同一账号，可继续未完成的导入；待确认预览在一小时后自动清理。</p></main>
<script>
(()=>{
'use strict';
let token='',batch=null,offset=0,authReady=false,working=false,pendingReady=false,pending=[];
const $=id=>document.getElementById(id);
const sources={chatgpt:'ChatGPT',claude:'Claude',deepseek:'DeepSeek'};
const guides={chatgpt:'ChatGPT：设置 → 数据控制 → 导出数据，下载导出 ZIP。',claude:'Claude 网页版或桌面端：Settings → Privacy → Export data，下载邮件里的导出文件。',deepseek:'DeepSeek：头像 → 设置 → 数据管理 → 导出所有历史对话。'};
function guide(){$('guide').textContent=guides[$('provider').value]}
guide();$('provider').onchange=guide;
function notice(s){$('notice').textContent=s}
function controls(){
 document.querySelectorAll('button').forEach(b=>b.disabled=working);
 $('loginSubmit').disabled=working||!authReady;
 $('upload').disabled=working||!pendingReady||Boolean(batch)||pending.length>=2;
}
function clearPreview(){batch=null;offset=0;$('preview').hidden=true;$('items').replaceChildren();$('summary').textContent='';$('warnings').textContent=''}
function resetAuth(){
 token='';pending=[];pendingReady=false;clearPreview();
 $('login').hidden=false;$('import').hidden=true;$('pending').hidden=true;
 $('pendingItems').replaceChildren();$('pendingStatus').textContent='';
 $('password').value='';$('account').value='';$('file').value='';controls();
}
async function request(path,method='GET',body){
 const multipart=body instanceof FormData;
 const response=await fetch('/v1'+path,{method,credentials:'omit',redirect:'error',cache:'no-store',headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body&&!multipart?{'Content-Type':'application/json'}:{})},...(body?{body:multipart?body:JSON.stringify(body)}:{})});
 if(response.status===401){resetAuth();const error=Error('登录已失效，请重新登录。');error.status=401;throw error}
 let data;try{data=await response.json()}catch{throw Error('服务未返回有效数据，请检查文件大小或稍后重试')}
 if(!response.ok){const error=Error(data.error?.message||'操作失败');error.status=response.status;throw error}
 return data;
}
async function run(fn){if(working)return;working=true;controls();try{await fn()}catch(e){notice(e.message)}finally{working=false;controls()}}
function render(data,append=false){
 if(!append){$('items').replaceChildren();offset=0}
 $('preview').hidden=false;
 $('summary').textContent=`${data.conversation_count} 段对话 · ${data.message_count} 条文字消息；忽略 ${data.skipped_conversations} 段空白或重复对话、${data.skipped_blocks} 个非正文内容块。`;
 $('warnings').textContent=data.warnings.join(' ');
 for(const item of data.items){
  const article=document.createElement('article'),title=document.createElement('strong'),text=document.createElement('p');
  title.textContent=item.title;text.textContent=item.message_count+' 条消息 · '+item.preview;article.append(title,text);
  for(const warning of item.warnings){const w=document.createElement('p');w.className='muted';w.textContent=warning;article.append(w)}
  $('items').append(article);
 }
 offset+=data.items.length;$('more').hidden=!data.has_more;
}
function renderPending(){
 $('pending').hidden=false;$('pendingItems').replaceChildren();
 $('pendingStatus').textContent=pending.length?`你有 ${pending.length} 份待确认的导入，可继续查看或取消。`:'没有待确认的导入，可以上传新文件。';
 for(const item of pending){
  const article=document.createElement('article'),title=document.createElement('strong'),description=document.createElement('p'),row=document.createElement('div');
  article.dataset.previewId=item.id;title.textContent=sources[item.provider]||'AI 对话';
  description.textContent=`${item.conversation_count} 段对话 · ${item.message_count} 条文字消息`;
  row.className='row';
  const resumeButton=document.createElement('button');resumeButton.type='button';resumeButton.className='secondary';resumeButton.textContent=batch===item.id?'重新查看当前预览':'继续查看';resumeButton.dataset.action='resume';resumeButton.onclick=()=>run(()=>resume(item.id));
  const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='secondary';cancelButton.textContent='取消这份导入';cancelButton.dataset.action='discard';cancelButton.onclick=()=>run(()=>discard(item.id));
  row.append(resumeButton,cancelButton);article.append(title,description,row);$('pendingItems').append(article);
 }
 controls();
}
async function loadPending(autoResume=false){
 pendingReady=false;$('pending').hidden=false;$('pendingStatus').textContent='正在读取待确认导入…';controls();
 try{
  const data=await request('/ai-history/previews');
  if(!Array.isArray(data.items))throw Error('服务未返回有效的待确认列表，请重试');
  pending=data.items;pendingReady=true;
  if(batch&&!pending.some(item=>item.id===batch))clearPreview();
  renderPending();
  if(autoResume&&pending.length)await resume(pending[0].id);
 }catch(e){if(e.status!==401)$('pendingStatus').textContent='暂时无法读取待确认导入，请点击刷新重试。';throw e}
 finally{controls()}
}
async function resume(id){
 try{
  const data=await request('/ai-history/previews/'+encodeURIComponent(id));
  if(data.completed){clearPreview();await loadPending();notice('这份导入已完成，列表已更新。');return}
  batch=data.id;$('provider').value=data.provider;guide();render(data);renderPending();notice('已恢复待确认导入，请检查后确认。');
 }catch(e){
  if(e.status!==404)throw e;
  if(batch===id)clearPreview();await loadPending();notice('这份预览已过期或已被处理，列表已更新。');
 }
}
async function refreshAfterAction(message){
 try{await loadPending();notice(message)}catch(e){if(e.status===401)throw e;notice(message+' 待确认列表暂时无法更新，请点击刷新重试。')}
}
async function discard(id){
 await request('/ai-history/previews/'+encodeURIComponent(id),'DELETE');
 if(batch===id)clearPreview();
 await refreshAfterAction('已取消并删除预览。');
}
function methodChanged(){
 const phone=$('authMethod').value==='phone_password';$('accountLabel').textContent=phone?'手机号':'邮箱';$('account').type=phone?'tel':'email';$('account').inputMode=phone?'tel':'email';$('account').placeholder=phone?'请输入11位手机号':'请输入邮箱';
 if(phone)$('account').pattern='(?:\\+86|0086)?1[3-9][0-9]{9}';else $('account').removeAttribute('pattern');$('account').value='';$('password').value='';
}
async function loadAuth(){
 authReady=false;controls();$('retryLogin').hidden=true;$('loginStatus').textContent='正在检查此服务器支持的登录方式…';
 try{
  const instance=await request('/instance');
  const methods=Array.isArray(instance.auth_methods)?[...new Set(instance.auth_methods.filter(m=>m==='phone_password'||m==='email_password'))]:[];
  if(!methods.length)throw Error('此服务器尚未提供可用的密码登录方式，请联系管理员');
  $('authMethod').replaceChildren(...methods.map(method=>{const option=document.createElement('option');option.value=method;option.textContent=method==='phone_password'?'手机号与密码':'邮箱与密码';return option}));
  $('authMethod').value=methods.includes('phone_password')?'phone_password':methods[0];$('methodLabel').hidden=methods.length<2;methodChanged();authReady=true;
  $('loginStatus').textContent=methods.length>1?'请选择与你手机账号一致的登录方式。':methods[0]==='phone_password'?'此服务器使用手机号与密码登录。':'此服务器使用邮箱与密码登录。';
 }catch(e){$('loginStatus').textContent='无法读取登录方式：'+e.message;$('retryLogin').hidden=false}
 finally{controls()}
}
$('authMethod').onchange=()=>{methodChanged();notice('')};$('retryLogin').onclick=()=>run(loadAuth);void loadAuth();
$('loginForm').onsubmit=e=>{
 e.preventDefault();if(!authReady)return;
 run(async()=>{
  const phone=$('authMethod').value==='phone_password';
  const data=await request(phone?'/auth/phone/login':'/auth/login','POST',{[phone?'phone':'email']:$('account').value.trim(),password:$('password').value});
  token=data.token;$('password').value='';$('login').hidden=true;$('import').hidden=false;
  await loadPending(true);if(!pending.length)notice('已登录，可以选择导出文件。');
 });
};
$('refreshPending').onclick=()=>run(()=>loadPending(!batch));
$('logout').onclick=()=>run(async()=>{
 let confirmed=false;
 try{if(batch)await request('/ai-history/previews/'+encodeURIComponent(batch),'DELETE');await request('/auth/logout','POST',{});confirmed=true}
 catch(e){confirmed=e.status===401}
 finally{resetAuth()}
 notice(confirmed?'已退出。':'已在此页面退出，网络恢复后可重新登录。');
});
$('upload').onclick=()=>run(async()=>{
 if(batch)throw Error('请先确认或取消当前预览');
 const file=$('file').files[0];if(!file)throw Error('请先选择文件');if(file.size>25*1024*1024)throw Error('文件超过 25 MB，请解压后分批选择对话 JSON');
 notice('正在上传和解析…');const form=new FormData();form.append('file',file);
 let data;
 try{data=await request('/ai-history/'+$('provider').value+'/preview','POST',form)}
 catch(e){
  if(e.status===401)throw e;
  try{await loadPending(true)}catch(recovery){if(recovery.status===401)throw recovery}
  if(batch){notice('已找回待确认导入，请检查预览后确认。');return}
  throw e;
 }
 batch=data.id;render(data);await refreshAfterAction('已解析，请检查预览后确认。');
});
$('more').onclick=()=>run(async()=>render(await request('/ai-history/previews/'+encodeURIComponent(batch)+'?offset='+offset),true));
$('cancel').onclick=()=>run(()=>discard(batch));
$('commit').onclick=()=>run(async()=>{
 notice('正在导入…');const data=await request('/ai-history/previews/'+encodeURIComponent(batch)+'/commit','POST',{all:true});
 clearPreview();$('file').value='';await refreshAfterAction(`导入完成：新增 ${data.imported} 段，更新 ${data.updated} 段，跳过 ${data.skipped} 段相同记录。可在手机查看。`);
});
})();
</script></html>"##;
