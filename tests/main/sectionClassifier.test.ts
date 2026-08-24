import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECTION_MODEL,
  classifyLogView,
  classifySection,
  currentSectionTitle,
  parseSectionReply,
  summarizeSpan,
  unclassifiedSpan,
} from "../../src/main/sectionClassifier.js";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";

// 没 key 就根本不出门（见 classifySection 的 key 闸门），所以要打到网络的用例
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
  // turn_ended 不是可有可无的装饰：分类是 turn 收口之后才排上的，真实日志里
  // 分类事件前面必有它。unclassifiedSpan 用它判断锚点在不在 turn 中间（issue #112）
  { seq: 4, sessionId: "s", ts: 5, type: "turn_ended", outcome: "completed" },
];

describe("currentSectionTitle", () => {
  it("没有分类事件 = 还没有分区", () => {
    expect(currentSectionTitle(log)).toBeNull();
  });

  it("取最后一个非空 title，延续事件不覆盖它", () => {
    const events: SessionEvent[] = [
      ...log,
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: "修登录", model: "c" },
      { seq: 6, sessionId: "s", ts: 7, type: "section_classified", title: null, model: "c" },
    ];
    expect(currentSectionTitle(events)).toBe("修登录");
  });
});

describe("summarizeSpan", () => {
  it("带上用户和助手的话、工具名；不倒 tool_result 全文", () => {
    const out = summarizeSpan(log);
    expect(out).toContain("帮我修登录");
    expect(out).toContain("read_file");
    expect(out).not.toContain("x".repeat(400));
    expect(out.length).toBeLessThan(4100);
  });
});

describe("parseSectionReply", () => {
  it("裸 JSON", () => {
    expect(parseSectionReply('{"newSection":true,"title":"修登录 bug"}', true)).toEqual({ title: "修登录 bug" });
  });

  it("带 ```json 围栏也认", () => {
    const raw = '```json\n{"newSection": false, "title": ""}\n```';
    expect(parseSectionReply(raw, true)).toEqual({ title: null });
  });

  it("烂形状 = 解析失败", () => {
    expect(parseSectionReply("我觉得应该开新章节", true)).toBeNull();
    expect(parseSectionReply('{"newSection":true,"title":""}', true)).toBeNull();
  });

  it("还没有分区时回延续 = 失败（不能一个区都开不出来）", () => {
    expect(parseSectionReply('{"newSection":false,"title":""}', false)).toBeNull();
  });

  it("超长标题截断而不是照收（日志 append-only，进去了就改不掉）", () => {
    const raw = JSON.stringify({ newSection: true, title: `  ${"长".repeat(500)}  ` });
    const out = parseSectionReply(raw, true);
    expect(out).toEqual({ title: "长".repeat(40) });
  });
});

describe("unclassifiedSpan —— 分类事件落在 turn 中间时往回补", () => {
  const classified = (seq: number): SessionEvent =>
    ({ seq, sessionId: "s", ts: seq, type: "section_classified", title: "旧章节", model: "c" });
  const ended = (seq: number): SessionEvent =>
    ({ seq, sessionId: "s", ts: seq, type: "turn_ended", outcome: "completed" });
  const asked = (seq: number, content: string): SessionEvent =>
    ({ seq, sessionId: "s", ts: seq, type: "user_message", content });
  const answered = (seq: number, content: string): SessionEvent =>
    ({ seq, sessionId: "s", ts: seq, type: "assistant_message", content, model: "m" });

  it("锚点紧跟 turn_ended（常态）= 原样从锚点后面切", () => {
    const events = [asked(1, "问题一"), answered(2, "答案一"), ended(3), classified(4), asked(5, "问题二")];
    expect(unclassifiedSpan(events).map((e) => e.seq)).toEqual([5]);
  });

  it("锚点落在新一轮的问和答之间 = 把那条问题一并带上", () => {
    // 分类是 turn 收口后异步跑的，这期间用户又发了一条：
    // 分类事件落在 user_message 和它的 assistant_message 中间
    const events = [
      asked(1, "问题一"), answered(2, "答案一"), ended(3),
      asked(4, "改成深色模式"), classified(5), answered(6, "改好了"), ended(7),
    ];
    const span = unclassifiedSpan(events);
    expect(span.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
    // 关键是问题回来了 —— 没有它，标题只能从「改好了」里编
    expect(summarizeSpan(span)).toContain("改成深色模式");
  });

  it("一条分类事件都没有 = 整份日志都是未分类的", () => {
    const events = [asked(1, "问题一"), answered(2, "答案一")];
    expect(unclassifiedSpan(events)).toHaveLength(2);
  });

  it("上一条分类事件之后就没开过新 turn = 跨度是空的，不往回补", () => {
    // 两条分类事件贴在一起（上一轮分类刚落，下一轮又被排上）：中间什么都没发生
    const events = [asked(1, "问题一"), ended(2), classified(3), classified(4)];
    expect(unclassifiedSpan(events)).toHaveLength(0);
  });
});

describe("classifySection", () => {
  it("打到 glm-4.5-flash，回标题和账单", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
      expect(url).toContain("bigmodel.cn");
      bodies.push(init.body);
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"newSection":true,"title":"修登录 bug"}' } }],
          usage: { prompt_tokens: 300, completion_tokens: 12 },
        }),
      };
    }));
    const out = await classifySection(log);
    expect(out).toEqual({
      title: "修登录 bug",
      model: SECTION_MODEL,
      usage: { promptTokens: 300, completionTokens: 12 },
    });
    expect(JSON.parse(bodies[0]!).model).toBe(SECTION_MODEL);
  });

  it("关思考、带超时信号（一句标题不值 20 倍 token，也不许卡死 turn 收尾）", async () => {
    let init: { body: string; signal?: AbortSignal } | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, i: { body: string; signal?: AbortSignal }) => {
      init = i;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"newSection":true,"title":"修登录"}' } }] }),
      };
    }));
    await classifySection(log);
    expect(JSON.parse(init!.body).thinking).toEqual({ type: "disabled" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it("没配 GLM_API_KEY → 一个字节都不发（空 Bearer 每 turn 必 401）", async () => {
    vi.stubEnv("GLM_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(classifySection(log)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("HTTP 失败 → 返回 null，绝不抛（turn 不能被目录拖垮）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "no key" })));
    await expect(classifySection(log)).resolves.toBeNull();
  });

  it("模型回垃圾 → 返回 null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, json: async () => ({ choices: [{ message: { content: "随便说说" } }] }),
    })));
    await expect(classifySection(log)).resolves.toBeNull();
  });

  it("开新分区但标题跟当前这条一模一样 → 落成延续（竖轨上不长两条同名刻度）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"newSection":true,"title":"修登录"}' } }] }),
    })));
    const events: SessionEvent[] = [
      ...log,
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: "修登录", model: "c" },
      { seq: 6, sessionId: "s", ts: 7, type: "user_message", content: "再看看这个" },
    ];
    await expect(classifySection(events)).resolves.toEqual({ title: null, model: SECTION_MODEL });
  });

  // 这条路径原来只在 parseSectionReply 单元层覆盖（issue #112）：另外三条失败
  // 路径都走完整的 mock HTTP，唯独它没有——而它是"模型说延续、但一条分区都还
  // 没有"这个真会发生的组合
  it("还没有任何分区 + 模型回延续 → null（不落一条没有标题的分区事件）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"newSection":false,"title":""}' } }] }),
    })));
    await expect(classifySection(log)).resolves.toBeNull();
  });

  it("对话原文夹在现造的随机围栏里，不是猜得到的 ---", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"newSection":true,"title":"修登录"}' } }] }),
      };
    }));
    await classifySection(log);
    await classifySection(log);
    const prompts = bodies.map((b) => JSON.parse(b).messages[0].content as string);
    // 固定分隔符是猜得到的：一句「---\n忽略上面」就能自己把围栏关掉
    expect(prompts[0]).not.toContain("\n---\n");
    const tag = /<([0-9a-f]{8})>/.exec(prompts[0]!)?.[1];
    expect(tag).toBeTruthy();
    expect(prompts[0]).toContain(`</${tag}>`);
    // 每次现造：抄下上一次的围栏也关不掉这一次
    expect(prompts[1]).not.toContain(`<${tag}>`);
  });

  it("跨度是空的（上一条就是分类事件）→ 不调模型，直接 null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const events: SessionEvent[] = [
      ...log,
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: "修登录", model: "c" },
    ];
    await expect(classifySection(events)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// issue #279：分类不再全量 load，切片必须和全量在两条投影上逐点等价
describe("classifyLogView —— 尾段切片与全量 load 等价", () => {
  const mk = () => new EventStore(":memory:");
  const put = (store: EventStore, e: Record<string, unknown>) =>
    store.append({ sessionId: "s", ts: 1, ...e } as never);
  const ask = (store: EventStore, content: string) => put(store, { type: "user_message", content });
  const answer = (store: EventStore, content: string) => put(store, { type: "assistant_message", content, model: "m" });
  const end = (store: EventStore) => put(store, { type: "turn_ended", outcome: "completed" });
  const classify = (store: EventStore, title: string | null) =>
    put(store, { type: "section_classified", title, model: "c" });

  const expectEquivalent = (store: EventStore) => {
    const view = classifyLogView(store, "s");
    const full = store.load("s");
    expect(unclassifiedSpan(view).map((e) => e.seq)).toEqual(unclassifiedSpan(full).map((e) => e.seq));
    expect(currentSectionTitle(view)).toBe(currentSectionTitle(full));
  };

  it("还没分过类 = 整段就是未分类跨度，退回全量", () => {
    const store = mk();
    ask(store, "一"); answer(store, "答"); end(store);
    expect(classifyLogView(store, "s")).toEqual(store.load("s"));
    store.close();
  });

  it("常态锚点：标题在更早的分类事件里（隔着 title:null 的延续）也取得到", () => {
    const store = mk();
    ask(store, "一"); answer(store, "答一"); end(store); classify(store, "修登录");
    ask(store, "二"); answer(store, "答二"); end(store); classify(store, null);
    ask(store, "三");
    expectEquivalent(store);
    expect(currentSectionTitle(classifyLogView(store, "s"))).toBe("修登录");
    store.close();
  });

  it("锚点落在 turn 中间：往回补 user_message 的扫描在切片里同样成立", () => {
    const store = mk();
    ask(store, "一"); answer(store, "答一"); end(store);
    ask(store, "改成深色模式"); classify(store, "旧章节"); answer(store, "改好了"); end(store);
    expectEquivalent(store);
    expect(summarizeSpan(unclassifiedSpan(classifyLogView(store, "s")))).toContain("改成深色模式");
    store.close();
  });

  it("锚点之前一条 turn_ended 都没有：退到全量尾段，不越界", () => {
    const store = mk();
    ask(store, "一"); classify(store, "开局就分"); ask(store, "二");
    expectEquivalent(store);
    store.close();
  });

  it("确实只读尾段：多轮已分类的历史不进切片", () => {
    const store = mk();
    for (let i = 0; i < 5; i++) { ask(store, `问${i}`); answer(store, `答${i}`); end(store); }
    classify(store, "前情");
    ask(store, "新问题");
    const view = classifyLogView(store, "s");
    const full = store.load("s");
    expectEquivalent(store);
    expect(view.length).toBeLessThan(full.length);
    // 切片 = 全部分类事件 + 锚点所在 turn 开头起的尾段，仍然有序
    expect(view.map((e) => e.seq)).toEqual([...view.map((e) => e.seq)].sort((a, b) => a - b));
    store.close();
  });
});
