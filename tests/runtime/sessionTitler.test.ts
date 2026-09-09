import { describe, expect, it, vi } from "vitest";
import {
  TITLE_MAX_CHARS,
  parseTitleReply,
  requestTitle,
  seedTitleFrom,
  titlePrompt,
  titleStepFor,
} from "../../services/runtime/src/sessionTitler.js";

describe("titleStepFor", () => {
  it("第 1 条人类发言走首行兜底（不打网关）", () => {
    expect(titleStepFor(1)).toBe("seed");
  });

  it("第 2 条起第一次模型命名，之后每 5 条重判一次", () => {
    expect(titleStepFor(2)).toBe("model");
    expect(titleStepFor(7)).toBe("model");
    expect(titleStepFor(12)).toBe("model");
  });

  it("其余什么都不做", () => {
    expect(titleStepFor(0)).toBe("none");
    expect(titleStepFor(3)).toBe("none");
    expect(titleStepFor(6)).toBe("none");
  });
});

describe("seedTitleFrom", () => {
  it("取首行、去空白", () => {
    expect(seedTitleFrom("  帮我看下这个报表  \n第二行")).toBe("帮我看下这个报表");
  });

  it("超长截断加省略号", () => {
    const long = "字".repeat(60);
    const out = seedTitleFrom(long);
    expect(out.length).toBe(41);
    expect(out.endsWith("…")).toBe(true);
  });

  it("空白正文回空串——调用方据此不写库", () => {
    expect(seedTitleFrom("   \n  ")).toBe("");
  });
});

describe("parseTitleReply", () => {
  it("KEEP 回 null（不改标题）", () => {
    expect(parseTitleReply("KEEP")).toBeNull();
    expect(parseTitleReply("  keep\n")).toBeNull();
  });

  it("正常标题取首行、剥引号、截断", () => {
    expect(parseTitleReply("「奶茶店选址」")).toBe("奶茶店选址");
    expect(parseTitleReply('"Q4 营销预算"\n（理由略）')).toBe("Q4 营销预算");
    expect(parseTitleReply("字".repeat(30))).toBe("字".repeat(TITLE_MAX_CHARS));
  });

  it("空串 / 只有标点 → null（认不出来一律回落，不是编一个）", () => {
    expect(parseTitleReply("")).toBeNull();
    expect(parseTitleReply("。。。")).toBeNull();
  });
});

describe("titlePrompt", () => {
  it("把当前标题一起给模型——这是「多数轮回 KEEP」的全部原因", () => {
    const p = titlePrompt({ currentTitle: "老名字", context: ["[张三]: 今天聊点别的"] });
    expect(p).toContain("老名字");
    expect(p).toContain("今天聊点别的");
  });

  it("还没有标题时说清楚是「还没有」，不是留一个空位", () => {
    expect(titlePrompt({ currentTitle: "", context: [] })).toContain("（还没有标题）");
  });
});

describe("requestTitle", () => {
  const input = { currentTitle: "老名字", context: ["[张三]: 换个话题"] };

  it("模型回新标题就用新标题", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "新名字" } }] }),
    });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap", "pricey"]))
      .resolves.toEqual({ title: "新名字", model: "cheap" });
    // 用的是最便宜那款（me.models 是从便宜到贵有序的，ADR-0237）
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as { model: string };
    expect(body.model).toBe("cheap");
  });

  it("网关非 2xx → null，标题保持现状", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });

  it("fetch 抛错 → null，不往外抛（命名失败不该让发言失败）", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });

  it("一款型号都没有 → null，一次网络都不打", async () => {
    const fetchImpl = vi.fn();
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, []))
      .resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("模型没回正文 → null", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: {} }] }) });
    await expect(requestTitle({ llmBase: "http://x/llm/v1", headers: {}, fetchImpl: fetchImpl as never }, input, ["cheap"]))
      .resolves.toBeNull();
  });
});
