import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { request, type UsagePriceModel } from "./api";
import { cnyToMicros, draftRates, microsToCny, priceDraft, UsagePriceFields, UsagePricePanel, UsagePriceSourceNote } from "./UsagePricePanel";

const model: UsagePriceModel = {
  model_key: "usage_" + "a".repeat(64), model: "configured-model", model_name: "实际模型", provider: "已配置服务",
  capabilities: ["llm"], rates: { input_cny_micros_per_million: null, output_cny_micros_per_million: null,
    cache_read_cny_micros_per_million: null, cache_write_cny_micros_per_million: null,
    audio_cny_micros_per_minute: null, image_cny_micros_each: null, request_cny_micros_each: null },
};
afterEach(() => vi.unstubAllGlobals());

describe("administrator usage prices", () => {
  it("discloses effective environment prices and the database override created by saving", () => {
    const environment = renderToStaticMarkup(<UsagePriceSourceNote source="environment" />);
    expect(environment).toContain("当前使用部署环境中的单价");
    expect(environment).toContain("保留其他生效单价");
    expect(environment).toContain("之后修改环境单价将不再自动生效");
    const database = renderToStaticMarkup(<UsagePriceSourceNote source="database" />);
    expect(database).toContain("优先于部署环境中的单价");
    expect(database).not.toContain("当前使用部署环境中的单价");
    const missing = renderToStaticMarkup(<UsagePriceSourceNote source="unconfigured" />);
    expect(missing).toContain("费用保持未知");
  });
  it("converts exact decimal yuan without rounding, conflating empty and zero, or exceeding safe integers", () => {
    expect(cnyToMicros(" ")).toBeNull();
    expect(cnyToMicros("0")).toBe(0);
    expect(cnyToMicros("0.000001")).toBe(1);
    expect(cnyToMicros("1.200001")).toBe(1_200_001);
    expect(cnyToMicros("9007199254.740991")).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of ["-1", "NaN", "Infinity", "1e2", ".1", "1.", "1,000", "0.0000001", "9007199254.740992"]) {
      expect(() => cnyToMicros(invalid), invalid).toThrow();
    }
    for (const integer of [0, 1, 1234567, Number.MAX_SAFE_INTEGER]) {
      expect(cnyToMicros(microsToCny(integer))).toBe(integer);
    }
    expect(microsToCny(null)).toBe("");
  });

  it("shows actual model prices with explicit token units and missing values, including cache writes", () => {
    const fixture = { ...model, rates: { ...model.rates, input_cny_micros_per_million: 0, output_cny_micros_per_million: 1_200_000 } };
    const html = renderToStaticMarkup(<UsagePriceFields model={fixture} draft={priceDraft(fixture)} disabled={false} onChange={() => {}} />);
    expect(html).toContain("实际模型");
    expect(html).toContain("元 / 百万 token");
    expect(html).toContain("缓存命中输入");
    expect(html).toContain("缓存写入");
    expect(html).toContain('value="0"');
    expect(html).toContain('value="1.2"');
    expect(html).toContain('placeholder="未配置" value=""');
    expect(html).not.toContain("API Key");
  });

  it("requires a deliberate ASR unit and cannot keep both audio and token rates on a unit switch", () => {
    const fixture: UsagePriceModel = { ...model, capabilities: ["asr"] };
    const draft = priceDraft(fixture);
    expect(draft.asrUnit).toBe("");
    const initial = renderToStaticMarkup(<UsagePriceFields model={fixture} draft={draft} disabled={false} onChange={() => {}} />);
    expect(initial).toContain("按服务商账单单位选择");
    expect(initial).not.toContain('inputmode="decimal"');
    draft.values.audio_cny_micros_per_minute = "0.12";
    draft.values.input_cny_micros_per_million = "10";
    draft.asrUnit = "minute";
    expect(draftRates(fixture, draft)).toMatchObject({ audio_cny_micros_per_minute: 120_000, input_cny_micros_per_million: null });
    draft.asrUnit = "tokens";
    expect(draftRates(fixture, draft)).toMatchObject({ audio_cny_micros_per_minute: null, input_cny_micros_per_million: 10_000_000 });
  });

  it("keeps the card collapsed and prices separate from provider settings", async () => {
    const html = renderToStaticMarkup(<UsagePricePanel session={{ user: { id: "owner", name: "Owner", email: "owner@example.test", role: "owner" }, csrf_token: "csrf" }}
      configRevision={7} hasConfigurationEdits={false} onError={() => {}} onNotice={() => {}} />);
    expect(html).toContain("费用估算单价");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('inputmode="decimal"');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await request("/usage-pricing", { method: "PATCH", csrf: "csrf", body: {
      expected_revision: 3, expected_config_revision: 7, changes: { [model.model_key]: draftRates(model, priceDraft(model)) },
    } });
    expect(fetch).toHaveBeenCalledWith("/admin/api/usage-pricing", expect.objectContaining({
      method: "PATCH", credentials: "same-origin", headers: expect.objectContaining({ "X-CSRF-Token": "csrf" }),
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ expected_revision: 3, expected_config_revision: 7 });
    expect(fetch.mock.calls[0][1].body).not.toContain("API_KEY");
  });
});
