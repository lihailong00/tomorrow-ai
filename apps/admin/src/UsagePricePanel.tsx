import { useEffect, useRef, useState } from "react";
import { ApiError, request, type Session, type UsagePriceModel, type UsagePricing, type UsageRates } from "./api";

const rateFields = ["input_cny_micros_per_million", "output_cny_micros_per_million",
  "cache_read_cny_micros_per_million", "cache_write_cny_micros_per_million",
  "audio_cny_micros_per_minute", "image_cny_micros_each", "request_cny_micros_each"] as const;
type RateField = typeof rateFields[number];
export type PriceDraft = { values: Record<RateField, string>; asrUnit: "" | "minute" | "tokens" };

/** Parse decimal yuan exactly; never round away excess precision or convert missing to zero. */
export function cnyToMicros(value: string): number | null {
  const clean = value.trim();
  if (!clean) return null;
  if (!/^\d+(?:\.\d{1,6})?$/.test(clean) || clean.length > 32) {
    throw new Error("单价须为非负金额，最多保留 6 位小数。");
  }
  const [whole, fraction = ""] = clean.split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("单价超出可保存的金额范围。");
  return Number(micros);
}

export function microsToCny(value: number | null): string {
  if (value === null) return "";
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("服务器返回的单价无效。");
  const integer = BigInt(value);
  const fraction = (integer % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${integer / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}

export function priceDraft(model: UsagePriceModel): PriceDraft {
  return {
    values: Object.fromEntries(rateFields.map(key => [key, microsToCny(model.rates[key])])) as PriceDraft["values"],
    asrUnit: model.rates.audio_cny_micros_per_minute !== null ? "minute" :
      rateFields.slice(0, 4).some(key => model.rates[key] !== null) ? "tokens" : "",
  };
}

export function draftRates(model: UsagePriceModel, draft: PriceDraft): UsageRates {
  const result = Object.fromEntries(rateFields.map(key => [key, cnyToMicros(draft.values[key])])) as UsageRates;
  if (model.capabilities.length === 1 && model.capabilities[0] === "asr") {
    if (draft.asrUnit === "minute") {
      for (const key of rateFields.slice(0, 4)) result[key] = null;
    } else if (draft.asrUnit === "tokens") result.audio_cny_micros_per_minute = null;
    else {
      for (const key of rateFields.slice(0, 5)) result[key] = null;
    }
  }
  return result;
}

const capabilityName = { llm: "对话与后台任务", asr: "语音识别", vision: "图片理解", embedding: "向量检索" };

export function UsagePriceSourceNote({ source }: { source: UsagePricing["source"] }) {
  const message = {
    environment: "当前使用部署环境中的单价。保存后将保留其他生效单价，并改用后台保存的价格表；之后修改环境单价将不再自动生效。",
    database: "当前使用后台保存的价格表，优先于部署环境中的单价。",
    unconfigured: "尚未配置价格表，空白单价对应的费用保持未知。",
  }[source];
  return <p className="input-help" role="status">{message}</p>;
}

export function UsagePriceFields({ model, draft, disabled, onChange }: {
  model: UsagePriceModel; draft: PriceDraft; disabled: boolean; onChange: (draft: PriceDraft) => void;
}) {
  const asrOnly = model.capabilities.length === 1 && model.capabilities[0] === "asr";
  const embeddingOnly = model.capabilities.length === 1 && model.capabilities[0] === "embedding";
  const field = (key: RateField, label: string) => <label className="field-label" key={key}>
    {label}
    <input aria-label={`${model.model_name} ${label}`} type="text" inputMode="decimal" autoComplete="off"
      maxLength={32} placeholder="未配置" value={draft.values[key]} disabled={disabled}
      onChange={event => onChange({ ...draft, values: { ...draft.values, [key]: event.target.value } })} />
  </label>;
  return <fieldset className="usage-price-model" disabled={disabled}>
    <legend>{model.model_name}</legend>
    <p className="input-help">{model.provider} · {model.capabilities.map(item => capabilityName[item]).join(" / ")} · 服务 {model.model_key.slice(-8)}</p>
    {asrOnly && <label className="field-label usage-price-unit">语音计价方式
      <select aria-label={`${model.model_name} 语音计价方式`} value={draft.asrUnit}
        onChange={event => onChange({ ...draft, asrUnit: event.target.value as PriceDraft["asrUnit"] })}>
        <option value="">未配置，请按服务商账单单位选择</option>
        <option value="minute">按音频分钟</option>
        <option value="tokens">按输入 / 输出 token</option>
      </select>
    </label>}
    {asrOnly && draft.asrUnit === "minute" && <div className="usage-price-grid">
      {field("audio_cny_micros_per_minute", "音频（元 / 分钟）")}
    </div>}
    {(!asrOnly || draft.asrUnit === "tokens") && <>
      <div className="usage-price-grid">
        {field("input_cny_micros_per_million", "输入（元 / 百万 token）")}
        {!embeddingOnly && field("output_cny_micros_per_million", "输出（元 / 百万 token）")}
        {!embeddingOnly && field("cache_read_cny_micros_per_million", "缓存命中输入（元 / 百万 token）")}
      </div>
      {!embeddingOnly && <details className="usage-price-advanced"><summary>高级单价</summary>
        <div className="usage-price-grid">{field("cache_write_cny_micros_per_million", "缓存写入（元 / 百万 token）")}</div>
      </details>}
    </>}
  </fieldset>;
}

export function UsagePricePanel({ session, configRevision, hasConfigurationEdits, onError, onNotice }: {
  session: Session; configRevision?: number; hasConfigurationEdits: boolean;
  onError: (error: unknown) => void; onNotice: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<UsagePricing | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const replace = (result: UsagePricing) => {
    // Validate before committing state so malformed amounts cannot become editable defaults.
    const next = Object.fromEntries(result.models.map(model => [model.model_key, priceDraft(model)]));
    setSnapshot(result); setDrafts(next);
  };
  async function load() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await request<UsagePricing>("/usage-pricing");
      if (mounted.current) replace(result);
    } catch (err) {
      if (mounted.current) { setError(err instanceof Error ? err.message : "单价加载失败，请重试。"); onError(err); }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  async function save() {
    if (!snapshot || pending.current) return;
    let changes: Record<string, UsageRates>;
    try {
      changes = Object.fromEntries(snapshot.models.filter(model =>
        JSON.stringify(model.rates) !== JSON.stringify(draftRates(model, drafts[model.model_key])))
        .map(model => [model.model_key, draftRates(model, drafts[model.model_key])]));
    } catch (err) { setError(err instanceof Error ? err.message : "请检查单价格式。"); return; }
    if (!Object.keys(changes).length) { setError("没有需要保存的单价修改。"); return; }
    pending.current = true; setBusy(true); setError("");
    try {
      const result = await request<UsagePricing>("/usage-pricing", { method: "PATCH", csrf: session.csrf_token,
        body: { expected_revision: snapshot.revision, expected_config_revision: snapshot.config_revision, changes } });
      if (mounted.current) { replace(result); onNotice("单价已保存，仅影响之后发起的请求；历史费用估算保持原样。"); }
    } catch (err) {
      if (mounted.current) {
        setError(err instanceof ApiError && err.status === 409 ? "单价或模型配置已更新。请重新加载，核对后再保存。" :
          err instanceof Error ? err.message : "单价保存失败，请重试。");
        onError(err);
      }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  }
  const stale = snapshot !== null && configRevision !== undefined && snapshot.config_revision !== configRevision;
  return <section className="card usage-price-card">
    <button type="button" className="usage-price-toggle" aria-expanded={open} aria-controls="usage-price-content"
      onClick={() => { setOpen(!open); if (!open && !snapshot) void load(); }}>
      <span><strong>费用估算单价</strong><small>按已保存的模型配置填写人民币单价</small></span><span aria-hidden="true">{open ? "−" : "+"}</span>
    </button>
    {open && <div id="usage-price-content" className="usage-price-content">
      <p className="input-help">请以服务商当前报价和计价单位为准，最多保留 6 位小数。空白表示未配置，填写 0 表示确认免费。这里只用于估算，不是账单；保存后仅用于新请求，历史记录保留当时的单价。</p>
      {snapshot && <UsagePriceSourceNote source={snapshot.source} />}
      {(hasConfigurationEdits || stale) && <p className="input-help danger-text" role="status">
        {hasConfigurationEdits ? "模型服务有未保存的修改，请先保存或放弃服务配置，再重新加载单价。" : "模型配置已变化，请重新加载单价后再保存。"}
      </p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {busy && !snapshot && <p role="status">正在加载模型单价…</p>}
      {snapshot?.models.map(model => <UsagePriceFields key={model.model_key} model={model}
        draft={drafts[model.model_key]} disabled={busy || stale || hasConfigurationEdits}
        onChange={draft => setDrafts(current => ({ ...current, [model.model_key]: draft }))} />)}
      {snapshot?.models.length === 0 && <p className="input-help">请先配置并保存可用的模型服务，再填写单价。</p>}
      <div className="usage-price-actions">
        <button className="button button-secondary" type="button" disabled={busy || hasConfigurationEdits} onClick={() => void load()}>重新加载{snapshot ? "（放弃单价修改）" : ""}</button>
        <button className="button button-primary" type="button" disabled={busy || stale || hasConfigurationEdits || !snapshot?.models.length} onClick={() => void save()}>{busy ? "处理中…" : "保存单价"}</button>
      </div>
    </div>}
  </section>;
}
