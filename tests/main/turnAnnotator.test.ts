// turnAnnotator（issue #284）：分区分类 + 跟进建议合并成一次便宜模型往返。
// 网络层用例从 sectionClassifier.test.ts 迁来（那边只剩纯函数）；
// 新增的关键覆盖：单次调用产两条结果、任一边形状烂只废那一边、账单只算一次。
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

const log: SessionEvent[] = [
  { seq: 0, sessionId: "s", ts: 1, type: "session_created", workspace: "/w" },
  { seq: 1, sessionId: "s", ts: 2, type: "user_message", content: "帮我修登录" },
  {
    seq: 2, sessionId: "s", ts: 3, type: "assistant_message", content: "看一下",
    model: "m", toolCalls: [{ id: "t1", name: "read_file", args: { path: "a.ts" } }],
  },
  { seq: 3, sessionId: "s", ts: 4, type: "tool_result", toolCallId: "t1", status: "ok", output: "x".repeat(9000) },
  { seq: 4, sessionId: "s", ts: 5, type: "turn_ended", outcome: "completed" },
];
// 最后一轮问答 = 最后一条 user_message 起（真实调用方传的就是这个切片）
const exchange = log.slice(1);

const okReply = (content: string, usage?: { prompt_tokens: number; completion_tokens: number }) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content } }],
    ...(usage ? { usage } : {}),
  }),
});

describe("annotateTurn —— 一次往返两边各取所需", () => {
  it("打到 glm-4.5-flash，一次 fetch 回分区 + 建议 + 账单", async () => {
    const bodies: string[] = [];
    const fetchSpy = vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toContain("bigmodel.cn");
      bodies.push(init.body);
      return okReply(
        '{"newSection":true,"title":"修登录 bug","suggestions":["跑一下测试","解释一下这段"]}',
        { prompt_tokens: 300, completion_tokens: 20 }
      );
    });
    vi.stubGlobal("fetch", fetchSpy);
    const out = await annotateTurn(log, exchange);
    expect(out).toEqual({
      section: { title: "修登录 bug" },
      suggestions: ["跑一下测试", "解释一下这段"],
      sessionTitle: null,
      model: ANNOTATE_MODEL,
      usage: { promptTokens: 300, completionTokens: 20 },
    });
    // 合并的意义就在这一条：两个结果，一次往返
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(bodies[0]!).model).toBe(ANNOTATE_MODEL);
  });

  it("关思考、带超时信号（一次小调用不值 20 倍 token，也不许卡死 turn 收尾）", async () => {
    let init: { body: string; signal?: AbortSignal } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, i: { body: string; signal?: AbortSignal }) => {
      init = i;
      return okReply('{"newSection":true,"title":"修登录","suggestions":["跑一下测试"]}');
    }));
    await annotateTurn(log, exchange);
    expect(JSON.parse(init!.body).thinking).toEqual({ type: "disabled" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("没配 GLM_API_KEY → 一个字节都不发（空 Bearer 每 turn 必 401）", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(annotateTurn(log, exchange)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 失败 → 返回 null，绝不抛（turn 不能被外挂拖垮）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "no key" })));
    await expect(annotateTurn(log, exchange)).resolves.toBeNull();
  });

  it("模型回垃圾 → 两边都烂 = null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply("随便说说")));
    await expect(annotateTurn(log, exchange)).resolves.toBeNull();
  });

  it("分区形状烂、建议是好的 → 只废分区那一边（分类靠锚点自愈）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply('{"newSection":"是","title":"","suggestions":["跑一下测试"]}')));
    const out = await annotateTurn(log, exchange);
    expect(out?.section).toBeNull();
    expect(out?.suggestions).toEqual(["跑一下测试"]);
  });

  it("建议清洗后一条不剩、分区是好的 → 只废建议那一边", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply('{"newSection":true,"title":"修登录 bug","suggestions":["   ",42]}')));
    const out = await annotateTurn(log, exchange);
    expect(out?.section).toEqual({ title: "修登录 bug" });
    expect(out?.suggestions).toBeNull();
  });

  it("开新分区但标题跟当前这条一模一样 → 落成延续（竖轨上不长两条同名刻度）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      okReply('{"newSection":true,"title":"修登录","suggestions":["跑一下测试"]}')));
    const events: SessionEvent[] = [
      ...log,
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: "修登录", model: "c" },
      { seq: 6, sessionId: "s", ts: 7, type: "user_message", content: "再看看这个" },
    ];
    const out = await annotateTurn(events, events.slice(-1));
    expect(out?.section).toEqual({ title: null });
  });

  it("还没有任何分区 + 模型回延续 → 分区边 null（不落一条没有标题的分区事件）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okReply('{"newSection":false,"title":"","suggestions":["跑一下测试"]}')));
    const out = await annotateTurn(log, exchange);
    expect(out?.section).toBeNull();
    expect(out?.suggestions).toEqual(["跑一下测试"]);
  });

  it("对话原文夹在现造的随机围栏里，不是猜得到的 ---", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"newSection":true,"title":"修登录","suggestions":["跑一下测试"]}');
    }));
    await annotateTurn(log, exchange);
    await annotateTurn(log, exchange);
    const prompts = bodies.map((b) => JSON.parse(b).messages[0].content as string);
    // 固定分隔符是猜得到的：一句「---\n忽略上面」就能自己把围栏关掉
    expect(prompts[0]).not.toContain("\n---\n");
    const tag = /<([0-9a-f]{8})>/.exec(prompts[0]!)?.[1];
    expect(tag).toBeTruthy();
    expect(prompts[0]).toContain(`</${tag}>`);
    // 每次现造：抄下上一次的围栏也关不掉这一次
    expect(prompts[1]).not.toContain(`<${tag}>`);
  });

  it("两边都没内容 → 不调模型，直接 null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(annotateTurn([], [])).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("跨度是空的（上一条就是分类事件）但有最后一轮 → 提示词只有任务二，分区边不解析", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      // 单任务时按提示词的形状回：只有 suggestions 键
      return okReply('{"suggestions":["跑一下测试"]}');
    }));
    const classified: SessionEvent[] = [
      ...log,
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: "修登录", model: "c" },
    ];
    const out = await annotateTurn(classified, exchange);
    expect(out?.section).toBeNull();
    expect(out?.suggestions).toEqual(["跑一下测试"]);
    const prompt = JSON.parse(bodies[0]!).messages[0].content as string;
    expect(prompt).not.toContain("章节目录");
    expect(prompt).toContain("跟进建议");
  });

  it("有跨度但没有最后一轮（日志里没有 user_message）→ 提示词只有任务一", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply('{"newSection":true,"title":"修登录 bug"}');
    }));
    const out = await annotateTurn(log, []);
    expect(out?.section).toEqual({ title: "修登录 bug" });
    expect(out?.suggestions).toBeNull();
    const prompt = JSON.parse(bodies[0]!).messages[0].content as string;
    expect(prompt).toContain("章节目录");
    expect(prompt).not.toContain("跟进建议");
  });

  // ── 任务三：会话自动命名（issue #335）──────────────────────

  it("带 titleSource → 提示词多任务三，sessionTitle 键与分区 title 键互不污染", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return okReply(
        '{"newSection":true,"title":"修登录 bug","suggestions":["跑一下测试"],"sessionTitle":"搜 vite 官网写文档"}'
      );
    }));
    const out = await annotateTurn(log, exchange, ANNOTATE_MODEL, "搜一下 vite 官网，把找到的链接写进 sources-test.md");
    expect(out?.section).toEqual({ title: "修登录 bug" });
    expect(out?.sessionTitle).toBe("搜 vite 官网写文档");
    const prompt = JSON.parse(bodies[0]!).messages[0].content as string;
    expect(prompt).toContain("会话标题");
    expect(prompt).toContain("sessionTitle");
  });

  it("不带 titleSource（默认）→ 提示词没有任务三，sessionTitle 恒 null", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      // 便宜模型爱多回键：就算它幻觉出 sessionTitle 也不该被采纳
      return okReply('{"newSection":true,"title":"修登录","suggestions":["跑一下测试"],"sessionTitle":"幻觉标题"}');
    }));
    const out = await annotateTurn(log, exchange);
    expect(out?.sessionTitle).toBeNull();
    expect(JSON.parse(bodies[0]!).messages[0].content as string).not.toContain("会话标题");
  });

  it("只有任务三有内容（分区/建议两边都空）→ 照样出门，只回标题", async () => {
    const fetchSpy = vi.fn(async () => okReply('{"sessionTitle":"搜 vite 官网写文档"}'));
    vi.stubGlobal("fetch", fetchSpy);
    const out = await annotateTurn([], [], ANNOTATE_MODEL, "搜一下 vite 官网，把找到的链接写进 sources-test.md");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ section: null, suggestions: null, sessionTitle: "搜 vite 官网写文档", model: ANNOTATE_MODEL });
  });

  it("标题那一边形状烂 → 只废标题（触发条件仍在，下个 turn 自愈）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      okReply('{"newSection":true,"title":"修登录 bug","suggestions":["跑一下测试"],"sessionTitle":""}')));
    const out = await annotateTurn(log, exchange, ANNOTATE_MODEL, "很长很长的第一条消息".repeat(5));
    expect(out?.section).toEqual({ title: "修登录 bug" });
    expect(out?.sessionTitle).toBeNull();
  });
});
