import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidEmailIdentifier } from "./api";

// The import page is an independently served, inline script. Exercise its
// actual validator with the same policy cases as every admin form.
const importPage = readFileSync(new URL("../../../crates/attachments/src/ai_history/web.rs", import.meta.url), "utf8");
const importFunction = importPage.match(/function isValidEmailIdentifier\(input\)\{[\s\S]*?\n\}/)?.[0];
if (!importFunction) throw new Error("Import mailbox validator missing");
const importEmailValid = new Function("TextEncoder", `return (${importFunction});`)(TextEncoder) as (input: string) => boolean;

describe("shared practical mailbox policy", () => {
  for (const [name, validate] of [["admin", isValidEmailIdentifier], ["AI import", importEmailValid]] as const) {
    it(`${name} accepts the international identifiers accepted by Rust`, () => {
      for (const input of [
        "用户.测试@example.test", "用户@例子.测试", "t02-qa@例子.测试",
        "o'connor@example.test", "  User+tag@Example.TEST  ",
        "\u00a0User@Example.test\u3000", "a..b@example.test",
        `${"用".repeat(80)}@example.test`, `${"a".repeat(241)}@example.test`,
      ]) expect(validate(input), input).toBe(true);
    });
    it(`${name} rejects incomplete, control-bearing or oversized identifiers`, () => {
      for (const input of [
        "", "@", "qa@", "@example.test", "qa@@example.test", "qa@example",
        "qa@.example", "qa@example.", "qa@exam..ple.test", "qa name@example.test",
        "qa\r\n@example.test", "qa@example.test\n", "\u0085qa@example.test",
        "qa\u009f@example.test", "qa@exam\u00a0ple.test",
        `${"用".repeat(81)}@example.test`, `${"a".repeat(242)}@example.test`,
      ]) expect(validate(input), input).toBe(false);
    });
  }
  it("keeps the import phone login and normalization at the server boundary", () => {
    expect(importPage).toContain("$('account').type=phone?'tel':'text'");
    expect(importPage).toContain("$('account').inputMode=phone?'tel':'email'");
    expect(importPage).toContain("const account=phone?normalizePhoneIdentifier($('account').value):$('account').value");
    expect(importPage).toContain("[phone?'phone':'email']:account,password");
  });
});
