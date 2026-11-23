import { describe, it, expect } from "vitest";
import { interpolateTranslation } from "./context";
import { translations } from "./translations";

describe("interpolateTranslation", () => {
  it("replaces template variables", () => {
    expect(interpolateTranslation("共 {count} 条", { count: 2 })).toBe("共 2 条");
    expect(interpolateTranslation("全 {count} 件", { count: 2 })).toBe("全 2 件");
  });

  it("keeps unknown variables unchanged", () => {
    expect(interpolateTranslation("{count} / {total}", { count: 2 })).toBe("2 / {total}");
  });
});

describe("translations parity", () => {
  it("has exact key parity across en and zh", () => {
    const enKeys = Object.keys(translations.en).sort();
    const zhKeys = Object.keys(translations.zh).sort();

    expect(zhKeys).toEqual(enKeys);
  });

  it("has matching placeholders in both languages for all keys", () => {
    for (const key of Object.keys(translations.en) as (keyof typeof translations.en)[]) {
      const enPlaceholders = [...translations.en[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const zhPlaceholders = [...translations.zh[key].matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

      expect(zhPlaceholders).toEqual(enPlaceholders);
    }
  });
});
