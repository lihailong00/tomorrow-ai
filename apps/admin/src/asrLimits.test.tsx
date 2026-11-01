import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderPanel } from "./ProviderPanel";
import { configurationChanges, type Setting } from "./api";
import { selectionEdits } from "./providers";

function settings(locked = false): Setting[] {
  return Object.entries({
    ASR_PROTOCOL: "qwen_asr", ASR_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ASR_MODEL: "qwen3-asr-flash", ASR_API_KEY: "configured",
    ASR_USER_DAILY_LIMIT: "1000", ASR_GLOBAL_DAILY_LIMIT: "5000",
  }).map(([key, value]) => ({ key, label: key, group: "speech", secret: key.endsWith("API_KEY"),
    value: key.endsWith("API_KEY") ? null : value, source: locked ? "environment" : "database",
    locked, configured: true }));
}

describe("speech usage limits", () => {
  it("keeps quota edits separate from provider and credential selection", () => {
    const saved = settings();
    const quota = { ASR_USER_DAILY_LIMIT: { mode: "replace" as const, value: "2000" } };
    const switched = selectionEdits(saved, quota, "speech", "custom");
    expect(switched.ASR_USER_DAILY_LIMIT).toBeUndefined();
    expect(configurationChanges(saved, { ...quota, ...switched }).ASR_USER_DAILY_LIMIT).toBe("2000");
    expect(configurationChanges(saved, quota)).toEqual({ ASR_USER_DAILY_LIMIT: "2000" });
  });
  it("shows rolling usage and deployment locks without revealing keys", () => {
    const html = renderToStaticMarkup(<ProviderPanel service="speech" settings={settings(true)} edits={{}} onEdits={() => {}} />);
    expect(html).toContain("最近 24 小时");
    expect(html).toContain("不是金额预算");
    expect(html).toMatch(/id="ASR_USER_DAILY_LIMIT"[^>]*disabled=""/);
    expect(html).toMatch(/id="ASR_GLOBAL_DAILY_LIMIT"[^>]*disabled=""/);
    expect(html).not.toContain('value="configured"');
  });
  it("preserves a draft reset and hides unsupported controls on older servers", () => {
    const saved = settings();
    const edits = { ASR_USER_DAILY_LIMIT: { mode: "replace" as const, value: "" } };
    const html = renderToStaticMarkup(<ProviderPanel service="speech" settings={saved} edits={edits} onEdits={() => {}} />);
    expect(html).toMatch(/id="ASR_USER_DAILY_LIMIT"[^>]*value=""/);
    expect(configurationChanges(saved, edits).ASR_USER_DAILY_LIMIT).toBe("");
    const older = saved.filter(item => !item.key.endsWith("DAILY_LIMIT"));
    expect(renderToStaticMarkup(<ProviderPanel service="speech" settings={older} edits={{}} onEdits={() => {}} />)).not.toContain('id="ASR_USER_DAILY_LIMIT"');
  });
});
