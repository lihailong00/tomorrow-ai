import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderPanel } from "./ProviderPanel";
import { configurationChanges, type Setting } from "./api";
import { binding, currentService, providerIssue, selectionEdits, type Edits } from "./providers";

function fixture(extra: Record<string, string> = {}, locked: string[] = []): Setting[] {
  const entries: Record<string, string> = {
    MODEL_BASE_URL: "", MODEL_NAME: "", MODEL_API_KEY: "",
    DEEPSEEK_BASE_URL: "", DEEPSEEK_MODEL: "", DEEPSEEK_API_KEY: "configured",
    ASR_BASE_URL: "", ASR_MODEL: "", ASR_API_KEY: "", ASR_PROTOCOL: "qwen_asr",
    PHOTO_VISION_BASE_URL: "", PHOTO_VISION_MODEL: "qwen3.7-flash", PHOTO_VISION_API_KEY: "", PHOTO_VISION_ENABLED: "true",
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
});
