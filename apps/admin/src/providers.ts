import type { Edit, Setting } from "./api";

export type Service = "model" | "speech" | "vision" | "embedding";
export type Preset = {
  id: string;
  name: string;
  mark: string;
  color: string;
  description: string;
  base: string;
  aliases?: string[];
  models: { id: string; name: string }[];
  services: Service[];
  protocol?: string;
  docs: string;
  regions?: { name: string; base: string }[];
};
const bailian = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const model = (id: string, name = id) => ({ id, name });

// Official documentation verified 2026-10-27. Only protocols supported by our
// server are listed. Subscription/coding gateways are separate credentials.
export const presets: Preset[] = [
  {
    id: "deepseek", name: "DeepSeek", mark: "D", color: "#526ce8",
    description: "对话与推理", base: "https://api.deepseek.com",
    models: [model("deepseek-flash", "DeepSeek Flash · 日常对话"), model("deepseek-v4-pro", "DeepSeek V4 Pro · 复杂任务")],
    services: ["model"], docs: "https://api-docs.deepseek.com/quick_start/agent_integrations/",
  },
  {
    id: "bailian", name: "阿里云百炼", mark: "千", color: "#b66b36",
    description: "通义千问", base: bailian,
    models: [model("qwen-plus", "千问 Plus · 通用"), model("qwen-flash", "千问 Flash · 轻量"), model("qwen-max", "千问 Max · 复杂任务")],
    services: ["model"], docs: "https://help.aliyun.com/zh/model-studio/get-api-key/",
    regions: [{ name: "中国内地 · 北京", base: bailian }, { name: "国际 · 新加坡", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }],
  },
  {
    id: "kimi", name: "Kimi", mark: "K", color: "#5c58bd",
    description: "月之暗面", base: "https://api.moonshot.cn/v1", aliases: ["https://api.moonshot.ai/v1"],
    models: [model("kimi-k3.1-pro", "Kimi K3.1 Pro"), model("kimi-k3", "Kimi K3"), model("kimi-k2.6", "Kimi K2.6")],
    services: ["model", "vision"], docs: "https://platform.kimi.com/docs/get-api-key",
  },
  {
    id: "glm", name: "智谱 GLM", mark: "智", color: "#478b97",
    description: "智谱开放平台", base: "https://open.bigmodel.cn/api/paas/v4",
    models: [model("glm-5.3-flash", "GLM-5.3-Flash"), model("glm-5.3", "GLM-5.3")],
    services: ["model"], docs: "https://docs.bigmodel.cn/cn/guide/develop/openai/introduction",
  },
  {
    id: "glm-vision", name: "智谱 GLM", mark: "智", color: "#478b97",
    description: "图片理解", base: "https://open.bigmodel.cn/api/paas/v4",
    models: [model("glm-5.3-flash", "GLM-5.3-Flash"), model("glm-4.6v", "GLM-4.6V")],
    services: ["vision"], docs: "https://docs.bigmodel.cn/cn/guide/start/model-overview",
  },
  {
    id: "minimax", name: "MiniMax", mark: "M", color: "#b16b80",
    description: "MiniMax 开放平台", base: "https://api.minimax.cn/v1", aliases: ["https://api.minimaxi.com/v1"],
    models: [model("MiniMax-M3.1-Flash"), model("MiniMax-M3"), model("MiniMax-M2.7")],
    services: ["model"], docs: "https://platform.minimax.cn/docs/api-reference/text-openai-api",
  },
  {
    id: "siliconflow", name: "硅基流动", mark: "S", color: "#8763bc",
    description: "开源模型服务", base: "https://api.siliconflow.cn/v1",
    models: [model("Pro/deepseek-ai/DeepSeek-R1", "DeepSeek R1")],
    services: ["model"], docs: "https://docs.siliconflow.cn/docs/userguide/quickstart",
  },
  {
    id: "qwen-asr", name: "阿里云百炼", mark: "千", color: "#b66b36",
    description: "千问语音识别", base: bailian, protocol: "qwen_asr",
    models: [model("qwen3-asr-flash", "千问 ASR Flash")], services: ["speech"],
    docs: "https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference",
    regions: [{ name: "中国内地 · 北京", base: bailian }, { name: "国际 · 新加坡", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }],
  },
  {
    id: "qwen-vision", name: "阿里云百炼", mark: "千", color: "#b66b36",
    description: "千问图片理解", base: bailian,
    models: [model("qwen3.7-flash", "千问 3.7 Flash"), model("qwen-vl-plus", "千问 VL Plus"), model("qwen-vl-max", "千问 VL Max")],
    services: ["vision"], docs: "https://help.aliyun.com/zh/model-studio/vision",
    regions: [{ name: "中国内地 · 北京", base: bailian }, { name: "国际 · 新加坡", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }],
  },
  {
    id: "qwen-embedding", name: "阿里云百炼", mark: "千", color: "#b66b36",
    description: "千问文本向量", base: bailian,
    models: [model("text-embedding-v4", "文本向量 V4 · 1024 维")], services: ["embedding"],
    docs: "https://help.aliyun.com/zh/model-studio/text-embedding-synchronous-api",
    regions: [{ name: "中国内地 · 北京", base: bailian }, { name: "国际 · 新加坡", base: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }],
  },
];
export type Edits = Record<string, Edit>;
export type Binding = { base: string; model: string; key: string; protocol?: string; enabled?: string };
export function value(settings: Setting[], edits: Edits, key: string): string {
  const edit = edits[key];
  if (edit?.mode === "delete") return "";
  if (edit?.mode === "replace") return edit.value;
  return String(settings.find(item => item.key === key)?.value ?? "");
}
export function hasKey(settings: Setting[], edits: Edits, key: string): boolean {
  const edit = edits[key];
  if (edit?.mode === "delete") return false;
  if (edit?.mode === "replace" && edit.value.trim()) return true;
  return settings.find(item => item.key === key)?.configured ?? false;
}
export function binding(settings: Setting[], edits: Edits, service: Service): Binding {
  if (service === "model") {
    const generic = edits.MODEL_BASE_URL?.mode === "replace" || edits.MODEL_NAME?.mode === "replace" ||
      value(settings, edits, "MODEL_BASE_URL").trim() ||
      value(settings, edits, "MODEL_NAME").trim() || hasKey(settings, edits, "MODEL_API_KEY");
    return generic ? { base: "MODEL_BASE_URL", model: "MODEL_NAME", key: "MODEL_API_KEY" } :
      { base: "DEEPSEEK_BASE_URL", model: "DEEPSEEK_MODEL", key: "DEEPSEEK_API_KEY" };
  }
  if (service === "speech") return { base: "ASR_BASE_URL", model: "ASR_MODEL", key: "ASR_API_KEY", protocol: "ASR_PROTOCOL" };
  const prefix = service === "vision" ? "PHOTO_VISION" : "PHOTO_EMBEDDING";
  return { base: prefix + "_BASE_URL", model: prefix + "_MODEL", key: prefix + "_API_KEY", enabled: prefix + "_ENABLED" };
}
export function endpoint(base: string): string {
  try {
    const url = new URL(base);
    return url.origin + url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  } catch { return base.replace(/\/+$/, ""); }
}
// Match the server fallback policy: a compatible protocol alone does not make
// a custom speech endpoint safe or usable for the other services.
export function officialQwenBase(base: string): boolean {
  try {
    const url = new URL(base.trim());
    const official = ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"].includes(url.hostname) ||
      url.hostname.endsWith(".cn-beijing.maas.aliyuncs.com") || url.hostname.endsWith(".ap-southeast-1.maas.aliyuncs.com");
    return official && url.protocol === "https:" && !url.username && !url.password && !url.href.includes("?") && !url.href.includes("#") &&
      url.pathname.replace(/\/+$/, "") === "/compatible-mode/v1";
  } catch { return false; }
}
export function currentService(settings: Setting[], edits: Edits, service: Service) {
  const keys = binding(settings, edits, service);
  let base = value(settings, edits, keys.base).trim();
  let name = value(settings, edits, keys.model).trim();
  if (keys.base === "DEEPSEEK_BASE_URL") {
    base ||= "https://api.deepseek.com";
    name ||= "deepseek-flash";
  }
  const inherited = (service === "vision" || service === "embedding") && !base;
  const asrBase = value(settings, edits, "ASR_BASE_URL").trim();
  const inheritedBase = value(settings, edits, "ASR_PROTOCOL") === "qwen_asr" && officialQwenBase(asrBase) ? asrBase : "";
  const canInherit = Boolean(inheritedBase) && hasKey(settings, edits, "ASR_API_KEY");
  const inheritanceReady = Boolean(inheritedBase) && (canInherit || hasKey(settings, edits, keys.key));
  const candidates = presets.filter(preset => preset.services.includes(service));
  const preset = candidates.find(preset => {
    if (preset.protocol && preset.protocol !== value(settings, edits, keys.protocol!)) return false;
    const urls = [preset.base, ...(preset.aliases ?? []), ...(preset.regions?.map(region => region.base) ?? [])];
    if (urls.some(url => endpoint(url) === endpoint(base))) return true;
    // Preserve existing workspace-specific addresses; never rewrite them on load.
    try {
      const host = new URL(base).hostname;
      return preset.id.startsWith("qwen") || preset.id === "bailian" ?
        /^[-a-z0-9]+\.(cn-beijing|ap-southeast-1)\.maas\.aliyuncs\.com$/.test(host) : false;
    } catch { return false; }
  });
  return {
    keys, base, name, inherited, inheritedBase, canInherit, inheritanceReady, preset,
    id: inherited ? "inherit" : (!base && service === "speech") ? "disabled" : preset?.id ?? "custom",
    hasKey: hasKey(settings, edits, keys.key),
  };
}
export function selectionEdits(settings: Setting[], edits: Edits, service: Service, id: string, regionBase?: string): Edits {
  const current = currentService(settings, edits, service);
  if (id === "inherit" && !current.canInherit) {
    throw new Error("沿用仅支持已配置 API Key 的官方百炼语音服务；当前语音服务请为图片理解和向量检索单独配置。");
  }
  if (!regionBase && current.id === id) return {};
  const preset = presets.find(item => item.id === id && item.services.includes(service));
  const keys = service === "model" ?
    id === "deepseek" ? { base: "DEEPSEEK_BASE_URL", model: "DEEPSEEK_MODEL", key: "DEEPSEEK_API_KEY" } :
      { base: "MODEL_BASE_URL", model: "MODEL_NAME", key: "MODEL_API_KEY" } : current.keys;
  const changes: Edits = {};
  const set = (key: string, next: string) => {
    if (value(settings, edits, key) !== next) changes[key] = { mode: "replace", value: next };
  };
  if (service === "model" && id === "deepseek") {
    for (const key of ["MODEL_BASE_URL", "MODEL_NAME", "MODEL_API_KEY"]) changes[key] = { mode: "delete", value: "" };
  }
  if (id === "disabled" || id === "inherit") {
    for (const key of [keys.base, keys.key]) changes[key] = { mode: "delete", value: "" };
    if (id === "disabled") changes[keys.model] = { mode: "delete", value: "" };
    if (id === "inherit") set(keys.model, service === "vision" ? "qwen3.7-flash" : "text-embedding-v4");
  } else {
    const base = regionBase ?? preset?.base ?? current.base;
    set(keys.base, base);
    set(keys.model, regionBase ? current.name : preset?.models[0]?.id ?? current.name);
    if (keys.protocol) set(keys.protocol, preset?.protocol ?? (value(settings, edits, keys.protocol) || "openai_transcriptions"));
    // Reusing a masked generic key after an endpoint switch would send the old
    // provider's credential to a different company. Deletion is staged atomically
    // with the endpoint, until the user supplies the new key or discards edits.
    const preservedDeepSeekKey = id === "deepseek" && !regionBase && hasKey(settings, edits, "DEEPSEEK_API_KEY") &&
      ["https://api.deepseek.com", "https://api.deepseek.com/v1"].includes(endpoint(value(settings, edits, "DEEPSEEK_BASE_URL") || "https://api.deepseek.com"));
    if (endpoint(base) !== endpoint(current.base) && !preservedDeepSeekKey || keys.key !== current.keys.key && !preservedDeepSeekKey) {
      changes[keys.key] = { mode: "delete", value: "" };
    }
  }
  if (keys.enabled) set(keys.enabled, "true");
  for (const key of Object.keys(changes)) {
    const item = settings.find(item => item.key === key);
    if (!item) delete changes[key];
    else if (item.locked) {
      const change = changes[key];
      if (change.mode === "delete" ? (item.secret ? item.configured : Boolean(String(item.value ?? "").trim())) :
        String(item.value ?? "") !== change.value) throw new Error("这项服务由服务器部署配置固定，暂时无法在网页切换厂商。");
      delete changes[key];
    }
  }
  return changes;
}
export function privateUrl(base: string): boolean {
  try {
    const url = new URL(base);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.includes("?") || url.href.includes("#")) return false;
    const host = url.hostname.toLowerCase();
    // Administrator-selected inference services only. Match Rust's
    // private_service_host and Pi's privateModelHost, never web-fetch policy.
    if (["localhost", "api", "backend", "tomorrow-api", "ollama", "vllm", "lmstudio", "host.docker.internal"].includes(host)) return true;
    if (host.startsWith("[") && host.endsWith("]")) {
      const address = host.slice(1, -1);
      return address === "::1" || /^f[cd][0-9a-f]{2}:/.test(address);
    }
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255) || !/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    return octets[0] === 127 || octets[0] === 10 ||
      octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 ||
      octets[0] === 192 && octets[1] === 168;
  } catch { return false; }
}
export function credentialScopeChanged(settings: Setting[], edits: Edits, service: Service): boolean {
  const current = currentService(settings, edits, service);
  const saved = value(settings, {}, current.keys.base).trim() ||
    (current.keys.base === "DEEPSEEK_BASE_URL" ? "https://api.deepseek.com" : "");
  return endpoint(current.base) !== endpoint(saved);
}
export function providerIssue(settings: Setting[], edits: Edits): string | undefined {
  for (const service of ["model", "speech", "vision", "embedding"] as Service[]) {
    const state = currentService(settings, edits, service);
    if (state.id === "disabled" || state.inherited || state.keys.enabled && value(settings, edits, state.keys.enabled) !== "true") continue;
    const routeChanged = [state.keys.base, state.keys.model, state.keys.protocol ?? ""].some(key =>
      edits[key]?.mode === "replace" && edits[key].value !== String(settings.find(item => item.key === key)?.value ?? ""));
    const freshKey = edits[state.keys.key]?.mode === "replace" && edits[state.keys.key].value.trim();
    if (!routeChanged || (state.hasKey && (!credentialScopeChanged(settings, edits, service) || freshKey)) ||
      privateUrl(state.base) && (service === "model" || service === "speech")) continue;
    return "请填写所选厂商的 API Key，再检查或保存配置。切换厂商不会沿用上一家的密钥。";
  }
  return undefined;
}
