// 型号旁边那枚厂商标（#1071）。两条判据：
//
// ① **每家都表过态**：`PROVIDER_MARK` 是穷举 `Record<ProviderId, …>`，目录里加一家
//    新厂商而不来写一笔的话 tsc 就红了 —— 这条断言补的是另一半：写了名字但资源
//    文件没进包（拼错一个字母）同样是静默失败，界面上只是少一枚标。
// ② **认不出的型号不安一家厂商**：`resolveModel` 有条 DeepSeek 兜底（为了"发得出
//    请求"），画到界面上就成了给一个陌生型号挂 DeepSeek 的鲸鱼。

import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PROVIDER_MARK, providerMarkOf } from "../../src/renderer/src/lib/providerMark.js";
import { PROVIDER_CATALOG } from "../../src/shared/providerCatalog.js";

const ASSETS = new URL("../../src/renderer/src/assets/providers/", import.meta.url);

describe("PROVIDER_MARK", () => {
  it("目录里的每一家都在表里表过态（穷举 Record 的运行时那一半）", () => {
    for (const p of PROVIDER_CATALOG) expect(Object.hasOwn(PROVIDER_MARK, p.id)).toBe(true);
  });

  it("表里写了名字的标，资源文件真的在 —— 拼错一个字母只会静默少一枚标", () => {
    const files = new Set(readdirSync(ASSETS).filter((f) => f.endsWith(".svg")).map((f) => f.replace(/\.svg$/, "")));
    for (const [provider, mark] of Object.entries(PROVIDER_MARK)) {
      if (mark !== null) expect(files, `${provider} → ${mark}.svg`).toContain(mark);
    }
  });
});

describe("providerMarkOf", () => {
  it("认得出的型号 → 那家的标", () => {
    expect(providerMarkOf("deepseek-v4-flash").mark).toBe("deepseek");
  });

  it("**认不出的型号不画标**，也不走 resolveModel 的 DeepSeek 兜底", () => {
    const v = providerMarkOf("some-selfhosted-llm");
    expect(v.mark).toBeNull();
    expect(v.letter).toBe("S"); // 退回型号 id 的首字
  });

  it("这家没有标 → 退回**厂商名**的首字，不是型号 id 的", () => {
    // 智谱在 simple-icons 里没有标；自己描一个「差不多像」的比画首字母更糟
    const v = providerMarkOf("glm-5.3");
    expect(v.mark).toBeNull();
    expect(v.letter).toBe("智");
  });

  it("同一个牌子两套账号体系共用一枚标（moonshot / kimicode，ADR-0117）", () => {
    expect(PROVIDER_MARK.moonshot).toBe(PROVIDER_MARK.kimicode);
  });
});
