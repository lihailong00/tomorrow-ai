import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  configurationChanges,
  isSessionExpired,
  connectUrl,
  request,
  remainingEdits,
  safePublicUrl,
  userLoginIdentity,
  userManagementLabel,
  type Setting,
  type User,
} from "./api";

afterEach(() => vi.unstubAllGlobals());
const key: Setting = {
  key: "DEEPSEEK_API_KEY",
  group: "ai",
  label: "Key",
  secret: true,
  locked: false,
  source: "database",
  configured: true,
};

describe("account management identities", () => {
  const user: User = { id: "fixture", email: "fixture@phone.tomorrow.local", name: "同名用户", created_at: "2026-10-28T00:00:00Z", disabled: false, role: "user" };
  it("distinguishes same-name phone accounts by their actual login numbers", () => {
    const first = { ...user, phone: "+8613800138000" };
    const second = { ...user, phone: "+8613900139000" };
    expect(userLoginIdentity(first)).toBe(first.phone);
    expect(userManagementLabel(first)).toBe("同名用户（+8613800138000）");
    expect(userManagementLabel(second)).toBe("同名用户（+8613900139000）");
    expect(userManagementLabel(first)).not.toContain("phone.tomorrow.local");
  });
  it("preserves email identities for old and email-only API responses", () => {
    const email = { ...user, email: "mail@example.test" };
    expect(userLoginIdentity(email)).toBe(email.email);
    expect(userLoginIdentity({ ...email, phone: null })).toBe(email.email);
    expect(userLoginIdentity({ ...email, phone: " " })).toBe(email.email);
    expect(userManagementLabel({ ...email, name: "" })).toBe(email.email);
  });
});

describe("API credential boundaries", () => {
  it("does not discard a valid session for an incorrect current password", () => {
    expect(
      isSessionExpired(
        new ApiError(401, "invalid_credentials", "当前密码不正确")
      )
    ).toBe(false);
    expect(
      isSessionExpired(new ApiError(401, "admin_login_required", "请登录"))
    ).toBe(true);
    expect(isSessionExpired(new ApiError(403, "forbidden", "无权操作"))).toBe(
      false
    );
  });
  it("uses a same-origin session and explicit CSRF header without persistent tokens", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 })
      );
    vi.stubGlobal("fetch", fetch);
    await request("/config", {
      method: "PATCH",
      csrf: "session-csrf",
      body: { expected_revision: 2, changes: { MODEL: "test" } },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/admin/api/config",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: expect.objectContaining({ "X-CSRF-Token": "session-csrf" }),
      })
    );
    expect(fetch.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
  it("never permits an absolute API URL", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(request("//external.example/config")).rejects.toThrow(
      "Invalid API path"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains the status and stable code for an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "请重新登录" },
          }),
          { status: 401 }
        )
      )
    );
    await expect(request("/session")).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
      message: "请重新登录",
    } satisfies Partial<ApiError>);
  });
});

describe("configuration secret edits", () => {
  it("acknowledges only the submitted version of each edit and retains later drafts", () => {
    const submitted = {
      INSTANCE_NAME: { mode: "replace", value: "Saved A" },
      MODEL_API_KEY: { mode: "replace", value: "saved-secret" },
      ASR_API_KEY: { mode: "delete", value: "" },
    } as const;
    const current = { ...submitted,
      INSTANCE_NAME: { mode: "replace", value: "Unsaved B" },
      ASR_API_KEY: { mode: "replace", value: "new-secret" },
      MODEL_NAME: { mode: "replace", value: "new-model" },
    } as const;
    expect(remainingEdits(current, submitted)).toEqual({
      INSTANCE_NAME: current.INSTANCE_NAME, ASR_API_KEY: current.ASR_API_KEY, MODEL_NAME: current.MODEL_NAME,
    });
    expect(remainingEdits(submitted, submitted)).toEqual({});
  });
  it("keeps configured secrets out of unchanged submissions", () => {
    expect(configurationChanges([key], {})).toEqual({});
    expect(
      configurationChanges([key], {
        [key.key]: { mode: "keep", value: "••••••••" },
      })
    ).toEqual({});
    expect(
      configurationChanges([key], {
        [key.key]: { mode: "replace", value: "  " },
      })
    ).toEqual({});
  });
  it("requires explicit deletion and only submits a replacement after input", () => {
    expect(
      configurationChanges([key], { [key.key]: { mode: "delete", value: "" } })
    ).toEqual({ DEEPSEEK_API_KEY: null });
    expect(
      configurationChanges([key], {
        [key.key]: { mode: "replace", value: "new-secret" },
      })
    ).toEqual({ DEEPSEEK_API_KEY: "new-secret" });
  });
  it("does not submit a locked environment setting", () => {
    expect(
      configurationChanges([{ ...key, locked: true }], {
        [key.key]: { mode: "replace", value: "anything" },
      })
    ).toEqual({});
  });
  it("detects an actual non-secret edit and preserves intentional empty values", () => {
    const model = { ...key, key: "MODEL", secret: false, value: "flash" };
    expect(
      configurationChanges([model], {
        MODEL: { mode: "replace", value: "flash" },
      })
    ).toEqual({});
    expect(
      configurationChanges([model], { MODEL: { mode: "replace", value: "" } })
    ).toEqual({ MODEL: "" });
  });
});

describe("phone connection information", () => {
  it("contains only server connection information", () => {
    const url = new URL(
      connectUrl(
        { instance_id: "instance-1", public_url: "https://self.example/" },
        "https://fallback.example"
      )
    );
    expect(url.protocol).toBe("tada:");
    expect([...url.searchParams.keys()].sort()).toEqual(["instance", "url"]);
    expect(url.searchParams.get("url")).toBe("https://self.example");
  });
  it("rejects a public URL carrying credentials or query secrets", () => {
    expect(
      safePublicUrl({ public_url: "https://user:secret@example.com" })
    ).toBe("");
    expect(
      safePublicUrl({ public_url: "https://example.com?key=secret" })
    ).toBe("");
    expect(safePublicUrl({ public_url: "https://example.com/" })).toBe(
      "https://example.com"
    );
    const connection = new URL(
      connectUrl(
        { id: "server-id", public_url: "https://example.com?key=secret" },
        "https://safe.example"
      )
    );
    expect(connection.searchParams.get("url")).toBe("https://safe.example");
    expect(connection.toString()).not.toContain("secret");
  });
});
