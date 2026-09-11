// turnAnnotator（issue #284）：turn 收口后的合并调用——跟进建议 + 自动命名 + 主题一次往返。
// 关键覆盖：一次调用产几份结果、任一边形状烂只废那一边、账单只算一次。
// 原来的「任务一：章节目录」（分区分类）随会话地图删掉了（ADR-0292）：这里钉住它不会
// 悄悄回来——提示词里没有章节目录，模型就算多回了 newSection/title 也没有任何一边采纳。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANNOTATE_MODEL, annotateTurn } from "../../src/main/turnAnnotator.js";
import type { SessionEvent } from "../../src/session/events.js";

// 没 key 就根本不出门（见 cheapAdapter 的 key 闸门），所以要打到网络的用例
// 必须先有个 key；CI 环境本来就没有
beforeEach(() => vi.stubEnv("GLM_API_KEY", "test-key"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// 最后一轮问答 = 最后一条 user_message 起（真实调用方传的就是这个切片）
const exchange: SessionEvent[] = [
  { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "帮我修登录" },
  {
    seq: 2, sessionId: "s", ts: 3, type: "assistant_message", content: "看一下",
    model: "m", toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }],
  },
  { seq: 3, sessionId: "s", ts: 4, type: "tool_result", toolCallId: "t1", status: "ok", output: "x".repeat(9000) },
  { seq: 4, sessionId: "s", ts: 5, type: "turn_ended", outcome: "completed" },
];

const okReply = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  }),
});

const promptOf = (body: string): string => JSON.parse(body).messages[0].content as string;

describe("annotateTurn —— 一次往返各取所需", () => {
  it("打到 glm-4.7-flash，一次 fetch 回建议 + 账单", async () => {
    const bodies: string[] = [];
    const fetchSpy = vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toContain("bigmodel.cn");
      bodies.push(init.body);
      return okReply('{"suggestions":["跑一下测试","解释一下这段"]}', { prompt_tokens: 300, completion_tokens: 20 });
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await annotateTurn(exchange);
    expect(out).toEqual({
      suggestions: ["跑一下测试", "解释一下这段"],
      sessionTitle: null,
      sessionTopic: null,
      model: ANNOTATE_MODEL,
      usage: { promptTokens: 300, completionTokens: 20 },
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bodies[0]!).model).toBe(ANNOTATE_MODEL);
  });

  it("提示词里没有章节目录（ADR-0292）；模型多回的 newSection/title 没有任何一边采纳", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"newSection":true,"title":"修登录 bug","suggestions":["跑一下测试"]}');
    }));
    const out = await annotateTurn(exchange);
    expect(out).not.toHaveProperty("section");
    expect(out?.suggestions).toEqual(["跑一下测试"]);
    const prompt = promptOf(bodies[0]!);
    expect(prompt).not.toContain("章节");
    expect(prompt).not.toContain("newSection");
    expect(prompt).toContain("【任务一：跟进建议】");
  });

  it("关思考、带超时信号（一次小调用不值 20 倍 token，也不许卡死 turn 收尾）", async () => {
    let init: { body: string; signal?: AbortSignal } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, i: { body: string; signal?: AbortSignal }) => {
      init = i;
      return okReply('{"suggestions":["跑一下测试"]}');
    }));
    await annotateTurn(exchange);
    expect(JSON.parse(init!.body).thinking).toEqual({ type: "disabled" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("没配 GLM_API_KEY → 一个字节都不发（空 Bearer 每 turn 必 401）", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(annotateTurn(exchange)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 失败 → 返回 null，绝不抛（turn 不能被外挂拖垮）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "no key" })));
    await expect(annotateTurn(exchange)).resolves.toBeNull();
  });

  it("模型回垃圾 → 每一边都烂 = null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply("随便说说")));
    await expect(annotateTurn(exchange)).resolves.toBeNull();
  });

  it("建议清洗后一条不剩、标题是好的 → 只废建议那一边", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      okReply('{"suggestions":["   ",42],"sessionTitle":"搜 vite 官网写文档"}')));
    const out = await annotateTurn(exchange, ANNOTATE_MODEL, "搜一下 vite 官网，把找到的链接写进 sources-test.md");
    expect(out?.suggestions).toBeNull();
    expect(out?.sessionTitle).toBe("搜 vite 官网写文档");
  });

  it("对话原文夹在现造的随机围栏里，不是猜得到的 ---", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"suggestions":["跑一下测试"]}');
    }));
    await annotateTurn(exchange);
    await annotateTurn(exchange);
    const prompts = bodies.map(promptOf);
    // 固定分隔符是猜得到的：一句「---\n忽略上面」就能自己把围栏关掉
    expect(prompts[0]).not.toContain("\n---\n");
    const tag = /<([0-9a-f]{8})>/.exec(prompts[0]!)?.[1];
    expect(tag).toBeTruthy();
    expect(prompts[0]).toContain(`</${tag}>`);
    // 每次现造：抄下上一次的围栏也关不掉这一次
    expect(prompts[1]).not.toContain(`<${tag}>`);
  });

  it("什么都没有（没有最后一轮、不要命名、不要主题）→ 不调模型，直接 null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(annotateTurn([])).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── 任务二：会话自动命名（issue #335）──────────────────────

  it("带 titleSource → 提示词多任务二，sessionTitle 键与别的键互不污染", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"suggestions":["跑一下测试"],"sessionTitle":"搜 vite 官网写文档"}');
    }));
    const out = await annotateTurn(exchange, ANNOTATE_MODEL, "搜一下 vite 官网，把找到的链接写进 sources-test.md");
    expect(out?.suggestions).toEqual(["跑一下测试"]);
    expect(out?.sessionTitle).toBe("搜 vite 官网写文档");
    const prompt = promptOf(bodies[0]!);
    expect(prompt).toContain("【任务二：会话标题】");
    expect(prompt).toContain("sessionTitle");
  });

  it("不带 titleSource（默认）→ 提示词没有任务二，sessionTitle 恒 null", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      // 便宜模型爱多回键：就算它幻觉出 sessionTitle 也不该被采纳
      return okReply('{"suggestions":["跑一下测试"],"sessionTitle":"幻觉标题"}');
    }));
    const out = await annotateTurn(exchange);
    expect(out?.sessionTitle).toBeNull();
    expect(promptOf(bodies[0]!)).not.toContain("会话标题");
  });

  it("只有任务二有内容（没有最后一轮）→ 照样出门，只回标题", async () => {
    const fetchSpy = vi.fn(async () => okReply('{"sessionTitle":"搜 vite 官网写文档"}'));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await annotateTurn([], ANNOTATE_MODEL, "搜一下 vite 官网，把找到的链接写进 sources-test.md");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      suggestions: null, sessionTitle: "搜 vite 官网写文档", sessionTopic: null, model: ANNOTATE_MODEL,
    });
  });

  it("标题那一边形状烂 → 只废标题（触发条件仍在，下个 turn 自愈）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      okReply('{"suggestions":["跑一下测试"],"sessionTitle":""}')));
    const out = await annotateTurn(exchange, ANNOTATE_MODEL, "很长很长的第一条消息".repeat(5));
    expect(out?.suggestions).toEqual(["跑一下测试"]);
    expect(out?.sessionTitle).toBeNull();
  });

  // ── 任务三：会话主题（#846）──────────────────────

  it("带 topicChoice：提示词含任务三，回复里的 sessionTopic 只认索引内的 slug", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"suggestions":["继续"],"sessionTopic":"hobbies"}');
    }));
    const out = await annotateTurn(exchange, undefined, null, {
      source: "帮我看看 WRX 改装",
      index: [{ slug: "work", label: "工作", entries: 0 }, { slug: "hobbies", label: "爱好", entries: 0 }],
    });
    expect(out?.sessionTopic).toBe("hobbies");
    expect(promptOf(bodies[0]!)).toContain("【任务三：会话主题】");
  });
});
