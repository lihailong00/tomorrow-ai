import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderPanel } from "./ProviderPanel";
import { configurationChanges, type Setting } from "./api";
import { binding, currentService, officialQwenBase, privateUrl, providerIssue, selectionEdits, type Edits } from "./providers";

function fixture(extra: Record<string, string> = {}, locked: string[] = []): Setting[] {
  const entries: Record<string, string> = {
    MODEL_BASE_URL: "", MODEL_NAME: "", MODEL_API_KEY: "",
    DEEPSEEK_BASE_URL: "", DEEPSEEK_MODEL: "", DEEPSEEK_API_KEY: "configured",
    ASR_BASE_URL: "", ASR_MODEL: "", ASR_API_KEY: "", ASR_PROTOCOL: "qwen_asr",
    PHOTO_VISION_BASE_URL: "", PHOTO_VISION_MODEL: "qwen3.7-flash", PHOTO_VISION_API_KEY: "", PHOTO_VISION_ENABLED: "true",
    PHOTO_EMBEDDING_BASE_URL: "", PHOTO_EMBEDDING_MODEL: "text-embedding-v4", PHOTO_EMBEDDING_API_KEY: "", PHOTO_EMBEDDING_ENABLED: "true",
    ...extra,
  };
  return Object.entries(entries).map(([key, value]) => ({
    key, label: key, group: "model", secret: key.endsWith("API_KEY"), configured: Boolean(value),
    value: key.endsWith("API_KEY") ? null : value, locked: locked.includes(key), source: "database",
  }));
}
describe("guided provider configuration", () => {
  it("recognizes the existing DeepSeek fallback without writing settings or exposing URLs as inputs", () => {
    const settings = fixture();
    expect(currentService(settings, {}, "model").id).toBe("deepseek");
    expect(currentService(settings, {}, "model").name).toBe("deepseek-flash");
    const html = renderToStaticMarkup(<ProviderPanel service="model" settings={settings} edits={{}} onEdits={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("选择模型");
    expect(html).not.toContain('type="url"');
    expect(html).not.toContain("DeepSeek API 地址");
    expect(configurationChanges(settings, {})).toEqual({});
  });
  it("switches from DeepSeek to Kimi using only the generic group and requires the new key", () => {
    const settings = fixture();
    const edits = selectionEdits(settings, {}, "model", "kimi");
    expect(configurationChanges(settings, edits)).toMatchObject({
      MODEL_BASE_URL: "https://api.moonshot.cn/v1", MODEL_NAME: "kimi-k3.1-pro", MODEL_API_KEY: null,
    });
    expect(edits.DEEPSEEK_API_KEY).toBeUndefined();
    expect(providerIssue(settings, edits)).toContain("API Key");
    edits.MODEL_API_KEY = { mode: "replace", value: "fixture-new-kimi-key" };
    expect(providerIssue(settings, edits)).toBeUndefined();
  });
  it("does not forward a saved generic key to the next provider or revive it after the replacement is cleared", () => {
    const settings = fixture({ MODEL_BASE_URL: "https://api.moonshot.cn/v1", MODEL_NAME: "kimi-k3", MODEL_API_KEY: "configured" });
    const edits = selectionEdits(settings, {}, "model", "glm");
    expect(edits.MODEL_API_KEY.mode).toBe("delete");
    const cleared: Edits = { ...edits, MODEL_API_KEY: { mode: "keep", value: "" } };
    expect(providerIssue(settings, cleared)).toContain("不会沿用");
    expect(providerIssue(settings, { ...edits, MODEL_API_KEY: { mode: "replace", value: "" } })).toContain("API Key");
  });
  it("returns to the specific DeepSeek credential without mixing the generic group", () => {
    const settings = fixture({ MODEL_BASE_URL: "https://api.moonshot.cn/v1", MODEL_NAME: "kimi-k3", MODEL_API_KEY: "configured" });
    const edits = selectionEdits(settings, {}, "model", "deepseek");
    const changes = configurationChanges(settings, edits);
    expect(changes.MODEL_BASE_URL).toBeNull();
    expect(changes.MODEL_API_KEY).toBeNull();
    expect(changes.DEEPSEEK_API_KEY).toBeUndefined();
    expect(binding(settings, edits, "model").key).toBe("DEEPSEEK_API_KEY");
    expect(providerIssue(settings, edits)).toBeUndefined();
  });
  it("preserves custom model names and workspace endpoints until the user changes them", () => {
    const settings = fixture({ MODEL_BASE_URL: "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", MODEL_NAME: "operator-custom-model", MODEL_API_KEY: "configured" });
    const state = currentService(settings, {}, "model");
    expect(state.id).toBe("bailian");
    expect(state.name).toBe("operator-custom-model");
    expect(selectionEdits(settings, {}, "model", "bailian")).toEqual({});
  });
  it("rejects a provider change pinned by environment variables before staging any mutation", () => {
    const settings = fixture({ MODEL_BASE_URL: "https://api.moonshot.cn/v1", MODEL_NAME: "kimi-k3", MODEL_API_KEY: "configured" }, ["MODEL_API_KEY"]);
    expect(() => selectionEdits(settings, {}, "model", "glm")).toThrow("部署配置");
    expect(configurationChanges(settings, {})).toEqual({});
  });
  it("changes the ASR protocol together with the provider, and clears the key on a region switch", () => {
    const settings = fixture({ ASR_PROTOCOL: "openai_transcriptions" });
    const edits = selectionEdits(settings, {}, "speech", "qwen-asr");
    expect(edits.ASR_PROTOCOL.value).toBe("qwen_asr");
    expect(edits.ASR_MODEL.value).toBe("qwen3-asr-flash");
    const saved = fixture({ ASR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", ASR_MODEL: "qwen3-asr-flash", ASR_API_KEY: "configured" });
    const region = selectionEdits(saved, {}, "speech", "qwen-asr", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    expect(region.ASR_API_KEY.mode).toBe("delete");
    expect(providerIssue(saved, region)).toContain("API Key");
  });
  it("preserves inherited photo credentials on load and allows explicit opt-in to a separate provider", () => {
    const settings = fixture({ ASR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", ASR_API_KEY: "configured" });
    expect(currentService(settings, {}, "vision").id).toBe("inherit");
    const edits = selectionEdits(settings, {}, "vision", "qwen-vision");
    expect(edits.PHOTO_VISION_BASE_URL.value).toBeTruthy();
    expect(providerIssue(settings, edits)).toContain("API Key");
    expect(configurationChanges(settings, {}).ASR_API_KEY).toBeUndefined();
  });
  it("keeps an intentionally empty custom draft in the generic group and permits local keyless inference", () => {
    const settings = fixture();
    expect(binding(settings, { MODEL_BASE_URL: { mode: "replace", value: "" } }, "model").key).toBe("MODEL_API_KEY");
    const edits: Edits = {
      MODEL_BASE_URL: { mode: "replace", value: "http://ollama:11434/v1" },
      MODEL_NAME: { mode: "replace", value: "my-local-model" }, MODEL_API_KEY: { mode: "delete", value: "" },
    };
    expect(providerIssue(settings, edits)).toBeUndefined();
  });
  it("offers inheritance only for the exact official Qwen endpoint policy", () => {
    for (const base of [
      "https://dashscope.aliyuncs.com/compatible-mode/v1/",
      "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "https://workspace.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    ]) expect(officialQwenBase(base)).toBe(true);
    for (const base of [
      "http://127.0.0.1:18782/v1", "https://custom.example/v1",
      "http://dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1",
      "https://user@dashscope.aliyuncs.com/compatible-mode/v1",
      "https://dashscope.aliyuncs.com/compatible-mode/v1?key=value",
      "https://dashscope.aliyuncs.com/compatible-mode/v1?",
      "https://dashscope.aliyuncs.com/compatible-mode/v1#fragment",
      "https://dashscope.aliyuncs.com/compatible-mode/v1#",
      "https://dashscope.aliyuncs.com/other/path",
    ]) expect(officialQwenBase(base)).toBe(false);
  });
  it.each(["vision", "embedding"] as const)("does not advertise custom ASR as inheritable for %s", service => {
    const settings = fixture({ ASR_BASE_URL: "http://127.0.0.1:18782/v1", ASR_API_KEY: "configured" });
    const state = currentService(settings, {}, service);
    expect(state.inheritedBase).toBe("");
    expect(state.canInherit).toBe(false);
    expect(state.inheritanceReady).toBe(false);
    expect(() => selectionEdits(settings, {}, service, "inherit")).toThrow("官方百炼");
    const html = renderToStaticMarkup(<ProviderPanel service={service} settings={settings} edits={{}} onEdits={() => {}} onTest={async () => { throw new Error("no calls expected"); }} />);
    expect(html).toContain("当前语音服务无法沿用");
    expect(html).not.toContain("沿用语音识别的百炼地址与密钥，无需重复填写");
    expect(html).toMatch(/aria-label="沿用语音服务"[^>]+disabled=""/);
    expect(configurationChanges(settings, {})).toEqual({});
  });
  it("requires a configured speech credential for a new inheritance selection", () => {
    const settings = fixture({ ASR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
    expect(currentService(settings, {}, "vision").canInherit).toBe(false);
    const draft: Edits = { ASR_API_KEY: { mode: "replace", value: "fixture-only" } };
    expect(currentService(settings, draft, "vision").canInherit).toBe(true);
    expect(currentService(settings, { ...draft, ASR_PROTOCOL: { mode: "replace", value: "openai_transcriptions" } }, "vision").canInherit).toBe(false);
    expect(currentService(settings, { ...draft, ASR_API_KEY: { mode: "delete", value: "" } }, "vision").canInherit).toBe(false);
  });
  it("recognizes the server's existing per-model key fallback without promising to reuse an absent speech key", () => {
    const settings = fixture({ ASR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", PHOTO_VISION_API_KEY: "configured" });
    const state = currentService(settings, {}, "vision");
    expect(state.inheritanceReady).toBe(true);
    expect(state.canInherit).toBe(false);
    const html = renderToStaticMarkup(<ProviderPanel service="vision" settings={settings} edits={{}} onEdits={() => {}} />);
    expect(html).toContain("使用此模型已配置的密钥");
  });
  it("provides one tab stop per provider group, including an unavailable saved inheritance selection", () => {
    for (const service of ["model", "speech", "vision", "embedding"] as const) {
      const html = renderToStaticMarkup(<ProviderPanel service={service} settings={fixture()} edits={{}} onEdits={() => {}} />);
      const radios = html.match(/<button[^>]+role="radio"[^>]*>/g) ?? [];
      expect(radios.length).toBeGreaterThan(1);
      expect(radios.filter(radio => radio.includes('tabindex="0"')).length).toBe(1);
      expect(radios.filter(radio => radio.includes('disabled=""')).every(radio => radio.includes('tabindex="-1"'))).toBe(true);
    }
  });
  it("permits keyless inference only for the exact Rust/Pi private hosts and address ranges", () => {
    const settings = fixture();
    for (const host of [
      "localhost", "api", "backend", "tomorrow-api", "host.docker.internal", "ollama", "vllm", "lmstudio",
      "127.0.0.1", "127.255.255.255", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.0.1",
      "[::1]", "[0:0:0:0:0:0:0:1]", "[fc00::1]", "[fd12:3456:789a::1]", "[fdff:ffff::1]",
    ]) {
      const base = `http://${host}:19483/v1`;
      expect(privateUrl(base), base).toBe(true);
      const edits: Edits = { MODEL_BASE_URL: { mode: "replace", value: base }, MODEL_NAME: { mode: "replace", value: "private-local" }, MODEL_API_KEY: { mode: "delete", value: "" } };
      expect(providerIssue(settings, edits), base).toBeUndefined();
    }
  });
  it("rejects lookalike public hosts and invalid private URLs without exempting vendor credentials", () => {
    for (const base of [
      "https://api.deepseek.com", "https://public.example.test/v1", "http://backend.example.test/v1",
      "http://10.attacker.test/v1", "http://127.evil.test/v1", "http://172.15.255.255/v1", "http://172.32.0.1/v1",
      "http://169.254.169.254/latest", "http://100.64.0.1/v1", "http://0.0.0.0/v1", "http://8.8.8.8/v1",
      "http://[::]/v1", "http://[fe80::1]/v1", "http://[2001:db8::1]/v1", "http://[::ffff:127.0.0.1]/v1",
      "ftp://backend/v1", "http://user:pass@backend/v1", "http://backend/v1?", "http://backend/v1#",
    ]) {
      expect(privateUrl(base), base).toBe(false);
      expect(providerIssue(fixture(), { MODEL_BASE_URL: { mode: "replace", value: base }, MODEL_NAME: { mode: "replace", value: "public-model" }, MODEL_API_KEY: { mode: "delete", value: "" } }), base).toContain("API Key");
    }
  });
});
