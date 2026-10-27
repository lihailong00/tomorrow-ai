import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon } from "./icons";
import { ApiError, type Edit, type Setting, type ProviderProbe } from "./api";
import { credentialScopeChanged, currentService, endpoint, presets, selectionEdits, value, type Edits, type Service } from "./providers";

const titles: Record<Service, string> = {
  model: "对话与思考", speech: "语音转文字", vision: "图片理解", embedding: "向量检索",
};
export function ProviderPanel({ service, settings, edits, onEdits, onTest }: {
  service: Service; settings: Setting[]; edits: Edits; onEdits: (changes: Edits) => void;
  onTest?: (signal: AbortSignal) => Promise<ProviderProbe>;
}) {
  const [custom, setCustom] = useState(false);
  const [customModel, setCustomModel] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProviderProbe | null>(null);
  const [testError, setTestError] = useState("");
  const testController = useRef<AbortController | null>(null);
  const state = currentService(settings, edits, service);
  const selected = custom ? "custom" : state.id;
  const choices = presets.filter(item => item.services.includes(service));
  const active = state.preset;
  const modelChoices = active?.models ?? (service === "vision" ? presets.find(preset => preset.id === "qwen-vision")?.models :
    service === "embedding" ? presets.find(preset => preset.id === "qwen-embedding")?.models : []) ?? [];
  const key = settings.find(item => item.key === state.keys.key);
  const keyEdit = edits[state.keys.key];
  const testFingerprint = JSON.stringify(settings.filter(item => item.group === service || state.inherited && ["ASR_BASE_URL", "ASR_API_KEY", "ASR_PROTOCOL"].includes(item.key))
    .map(item => [item.key, item.value, item.configured, item.locked, edits[item.key]]));
  useEffect(() => {
    testController.current?.abort(); testController.current = null;
    setTesting(false); setTestResult(null); setTestError("");
    return () => { testController.current?.abort(); };
  }, [testFingerprint]);
  async function testConnection() {
    if (!onTest || testing) return;
    const controller = new AbortController();
    testController.current = controller;
    setTesting(true); setTestResult(null); setTestError("");
    try {
      const result = await onTest(controller.signal);
      if (!controller.signal.aborted) setTestResult(result);
    } catch (failure) {
      if (!controller.signal.aborted) setTestError(failure instanceof ApiError ? failure.message : "暂时无法完成测试，请检查服务器连接后重试。");
    } finally {
      if (!controller.signal.aborted) setTesting(false);
    }
  }
  const showKeyInput = !key?.locked && (replacing || keyEdit?.mode === "replace" || !state.hasKey);
  const keyValue = keyEdit?.mode === "replace" ? keyEdit.value : "";
  const change = (field: string, next: string) => onEdits({ [field]: { mode: "replace", value: next } });
  useEffect(() => {
    if (!Object.keys(edits).length) { setCustom(false); setCustomModel(false); setReplacing(false); setError(""); }
  }, [edits]);
  function choose(id: string, region?: string) {
    try {
      const updates = selectionEdits(settings, edits, service, id, region);
      onEdits(updates);
      setCustom(id === "custom");
      setCustomModel(false);
      setReplacing(false);
      setError("");
    } catch (failure) { setError((failure as Error).message); }
  }
  const customMode = selected === "custom";
  const blocked = (field: string) => settings.find(item => item.key === field)?.locked ?? false;
  const inherited = selected === "inherit";
  const disabled = selected === "disabled";
  return (
    <section className="card provider-panel" aria-label={titles[service]}>
      <div className="section-head">
        <div><h2>{titles[service]}</h2><p>选择服务商和模型，填入 API Key 即可。接口地址会自动配置。</p></div>
        <span className="settings-section-icon"><Icon name={service === "model" ? "spark" : service === "speech" ? "phone" : "link"} size={20} /></span>
      </div>
      <div className="provider-step-title"><span>1</span><strong>选择服务商</strong><small>使用对应平台的 API Key</small></div>
      <div className="provider-cards" role="radiogroup" aria-label={titles[service] + "服务商"}>
        {choices.map(preset => (
          <button type="button" key={preset.id} role="radio" aria-label={preset.name} aria-checked={selected === preset.id}
            className={"provider-choice " + (selected === preset.id ? "provider-selected" : "")}
            onClick={() => choose(preset.id)}>
            <span className="provider-mark" style={{ "--provider-color": preset.color } as CSSProperties}>{preset.mark}</span>
            <span><strong>{preset.name}</strong><small>{preset.description}</small></span>
            {selected === preset.id && <span className="provider-check">✓</span>}
          </button>
        ))}
        {(service === "vision" || service === "embedding") && (
          <button type="button" role="radio" aria-label="沿用语音服务" aria-checked={inherited}
            disabled={!state.canInherit}
            className={"provider-choice " + (inherited ? "provider-selected" : "")} onClick={() => choose("inherit")}>
            <span className="provider-mark provider-mark-neutral"><Icon name="link" size={18} /></span>
            <span><strong>沿用语音服务</strong><small>{state.canInherit ? "使用已配置的百炼账号" : "需先配置官方百炼地址与密钥"}</small></span>
            {inherited && <span className="provider-check">✓</span>}
          </button>
        )}
        <button type="button" role="radio" aria-label="自定义接入" aria-checked={customMode}
          className={"provider-choice " + (customMode ? "provider-selected" : "")} onClick={() => choose("custom")}>
          <span className="provider-mark provider-mark-neutral">＋</span><span><strong>自定义接入</strong><small>兼容服务或本地模型</small></span>
          {customMode && <span className="provider-check">✓</span>}
        </button>
        {service === "speech" && (
          <button type="button" role="radio" aria-label="暂不启用" aria-checked={disabled}
            className={"provider-choice " + (disabled ? "provider-selected" : "")} onClick={() => choose("disabled")}>
            <span className="provider-mark provider-mark-neutral">—</span><span><strong>暂不启用</strong><small>稍后再配置</small></span>
            {disabled && <span className="provider-check">✓</span>}
          </button>
        )}
      </div>
      {error && <p className="provider-error" role="alert">{error}</p>}
      {!disabled && (
        <>
          {inherited ? <div className="provider-inherit-note"><Icon name="link" size={18} /><p>
            {state.inheritanceReady ? (state.hasKey ? "沿用语音识别的百炼地址，使用此模型已配置的密钥。" : "沿用语音识别的百炼地址与密钥，无需重复填写。") : "当前语音服务无法沿用。沿用仅支持官方百炼地址与已配置的密钥；请先配置百炼语音，或在上方为此模型单独选择服务商。"}
            <small>图片理解和向量检索仍分别使用各自的模型。</small>
          </p></div> : null}
          <div className="provider-form-grid">
            {active?.regions && !inherited && !customMode && (
              <div className="setting-field">
                <label htmlFor={service + "-region"}>服务地域</label>
                <select id={service + "-region"} value={active.regions.find(region => endpoint(region.base) === endpoint(state.base))?.base ?? "current"}
                  disabled={blocked(state.keys.base)} onChange={event => choose(active.id, event.target.value)}>
                  {!active.regions.some(region => endpoint(region.base) === endpoint(state.base)) && <option value="current">沿用当前业务空间 / 地域</option>}
                  {active.regions.map(region => <option key={region.base} value={region.base}>{region.name}</option>)}
                </select>
                <p className="input-help">与创建 API Key 时选择的地域保持一致。</p>
              </div>
            )}
            {!customMode && (
              <div className="setting-field">
                <label htmlFor={service + "-model"}><span className="provider-field-step">2</span>选择模型</label>
                <select id={service + "-model"} disabled={blocked(state.keys.model)}
                  value={customModel ? "__other__" : state.name}
                  onChange={event => { setCustomModel(event.target.value === "__other__"); if (event.target.value !== "__other__") change(state.keys.model, event.target.value); }}>
                  {!modelChoices.some(model => model.id === state.name) && <option value={state.name}>{state.name ? "当前模型 · " + state.name : "请选择模型"}</option>}
                  {modelChoices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                  <option value="__other__">其他模型（高级）</option>
                </select>
                {customModel && <input aria-label={titles[service] + "自定义模型"} className="provider-other-model" value={state.name} disabled={blocked(state.keys.model)}
                  placeholder="填写该平台提供的模型 ID" onChange={event => change(state.keys.model, event.target.value)} />}
                <p className="input-help">选择后自动使用对应模型，无需手动填写名称。</p>
              </div>
            )}
            {!inherited && (
              <div className="setting-field provider-key-field">
                <div className="setting-title"><label htmlFor={service + "-key"}><span className="provider-field-step">3</span>{active?.name ?? "服务"} API Key</label>
                  {key?.locked ? <span className="badge badge-neutral">部署配置管理</span> : state.hasKey && <span className="badge badge-green">已配置</span>}
                </div>
                {showKeyInput ? <input id={service + "-key"} type="password" autoComplete="new-password" spellCheck={false}
                  placeholder={state.hasKey ? "输入新 Key；留空保留当前密钥" : "粘贴所选服务商的 API Key"} value={keyValue}
                  onChange={event => {
                    const input = event.target.value;
                    const edit: Edit = input.trim() ? { mode: "replace", value: input } :
                      keyEdit?.mode === "delete" || !state.hasKey || credentialScopeChanged(settings, edits, service) ? { mode: "delete", value: "" } : { mode: "keep", value: "" };
                    onEdits({ [state.keys.key]: edit });
                  }} /> :
                  <div className="secret-placeholder"><Icon name="lock" size={15} /><span>••••••••••••••••</span>
                    {!key?.locked && <button type="button" className="text-button" onClick={() => setReplacing(true)}>更换密钥</button>}
                  </div>}
                <div className="provider-key-help"><p className="input-help">密钥加密保存在当前服务器，保存后不会回显。</p>
                  {active && !customMode && <a href={active.docs} target="_blank" rel="noreferrer">获取 API Key ↗</a>}
                </div>
                {!key?.locked && key?.configured && <button type="button" className="text-button muted" onClick={() => {
                  onEdits({ [state.keys.key]: { mode: "delete", value: "" } }); setReplacing(false);
                }}>删除密钥</button>}
              </div>
            )}
          </div>
          {customMode && <details className="provider-advanced" open>
            <summary>自定义接入设置</summary>
            <p>适用于兼容接口和自建模型。常见服务商请直接使用上方预设。</p>
            <div className="settings-grid">
              <div className="setting-field"><label htmlFor={service + "-custom-base"}>服务地址</label>
                <input id={service + "-custom-base"} type="url" value={state.base} disabled={blocked(state.keys.base)} placeholder="https://你的服务地址/v1"
                  onChange={event => {
                    const updates: Edits = { [state.keys.base]: { mode: "replace", value: event.target.value } };
                    if (endpoint(event.target.value) !== endpoint(state.base)) {
                      if (key?.locked) { setError("密钥由部署配置固定，无法更换接收密钥的服务地址。"); return; }
                      updates[state.keys.key] = { mode: "delete", value: "" };
                    }
                    onEdits(updates);
                  }} />
              </div>
              <div className="setting-field"><label htmlFor={service + "-custom-model"}>模型 ID</label>
                <input id={service + "-custom-model"} value={state.name} disabled={blocked(state.keys.model)} onChange={event => change(state.keys.model, event.target.value)} />
              </div>
              {state.keys.protocol && <div className="setting-field"><label htmlFor={service + "-protocol"}>转写接口类型</label>
                <select id={service + "-protocol"} value={value(settings, edits, state.keys.protocol)} disabled={blocked(state.keys.protocol)} onChange={event => change(state.keys.protocol!, event.target.value)}>
                  <option value="openai_transcriptions">标准语音转写接口</option><option value="qwen_asr">千问音频对话接口</option>
                </select></div>}
            </div>
            <p>{service === "embedding" ? "向量服务须支持 1024 维文本向量。" : service === "model" ? "使用支持工具调用的 Chat Completions 兼容接口。本地无鉴权模型可不填 Key。" : "仅支持当前服务器已实现的兼容接口。"}</p>
          </details>}
          {!customMode && !inherited && <details className="provider-advanced"><summary>查看自动配置的接口</summary>
            <code>{state.base}</code><p>地址已自动填写，无需修改。业务空间专属域名可通过“自定义接入”设置。</p>
          </details>}
          {onTest && <div className="provider-test">
            <div className="provider-test-actions">
              <button type="button" className="button button-secondary" disabled={testing || inherited && !state.inheritanceReady}
                onClick={() => void testConnection()} aria-label={titles[service] + "测试连接"}>
                <Icon name={service === "speech" ? "phone" : "spark"} size={16} />
                {testing ? ({ model: "正在连接模型…", speech: "正在校验转写…", vision: "正在校验识图…", embedding: "正在校验向量…" }[service]) : "测试连接"}
              </button>
              <p>{{ model: "发送一条简短测试消息，可能产生少量模型费用。", speech: "使用内置短音频，可能产生少量语音识别费用。",
                vision: "发送内置测试图片，实际校验识图结果，可能产生少量模型费用。", embedding: "发送一段内置短文本，实际校验向量结果，可能产生少量模型费用。" }[service]}
                <small>测试当前填写的配置，不会自动保存。</small></p>
            </div>
            {service === "speech" && <p className="provider-test-sample">测试音频：“明天上午九点提醒我开会。” · 当前支持千问 ASR Flash</p>}
            {service === "vision" && <p className="provider-test-sample">测试图片：白底红色圆形 · 校验颜色和形状 · 测试不会自动开启图片理解</p>}
            {service === "embedding" && <p className="provider-test-sample">测试短文本：“明天上午九点提醒我开会。” · 校验 1024 维有效向量 · 测试不会自动开启向量检索</p>}
            <div aria-live="polite">
              {testResult && <div className={"provider-test-result " + (testResult.ok ? "probe-success" : "probe-failure")} role="status">
                <strong>{testResult.ok ? "✓ " : "!"} {testResult.message}</strong>
                <span>{Math.round(testResult.elapsed_ms).toLocaleString()} 毫秒{testResult.upstream_status ? " · HTTP " + testResult.upstream_status : ""}</span>
              </div>}
              {testError && <p className="provider-error" role="alert">{testError}</p>}
            </div>
          </div>}
        </>
      )}
      {state.keys.enabled && <div className="provider-enable">
        <label htmlFor={service + "-enabled"}>启用{titles[service]}</label>
        <select id={service + "-enabled"} value={value(settings, edits, state.keys.enabled)} disabled={blocked(state.keys.enabled)} onChange={event => change(state.keys.enabled!, event.target.value)}>
          <option value="true">开启</option><option value="false">关闭</option>
        </select>
        <span>开启后仍需用户在手机端单独授权。</span>
      </div>}
    </section>
  );
}
