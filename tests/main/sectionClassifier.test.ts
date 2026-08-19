import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SECTION_MODEL,
  classifySection,
  currentSectionTitle,
  parseSectionReply,
  summarizeSpan,
} from "../../src/main/sectionClassifier.js";
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
];

describe("currentSectionTitle", () => {
  it("没有分类事件 = 还没有分区", () => {
    expect(currentSectionTitle(log)).toBeNull();
  });

  it("取最后一个非空 title，延续事件不覆盖它", () => {
    const events: SessionEvent[] = [
      ...log,
      { seq: 4, sessionId: "s", ts: 5, type: "section_classified", title: "修登录", model: "c" },
      { seq: 5, sessionId: "s", ts: 6, type: "section_classified", title: null, model: "c" },
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

  it("跨度是空的（上一条就是分类事件）→ 不调模型，直接 null", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const events: SessionEvent[] = [
      ...log,
      { seq: 4, sessionId: "s", ts: 5, type: "section_classified", title: "修登录", model: "c" },
    ];
    await expect(classifySection(events)).resolves.toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
