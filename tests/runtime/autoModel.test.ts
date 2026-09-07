import { describe, expect, it, vi } from "vitest";
import {
  CLASSIFY_MAX_CHARS, modelForDifficulty, parseDifficulty, pickAutoModel,
} from "../../services/runtime/src/autoModel.js";

const CHEAP = "cheap-model";
const MID = "mid-model";
const STRONG = "strong-model";
const MODELS = [CHEAP, MID, STRONG]; // edge 给的顺序：从便宜到贵

const deps = (fetchImpl: typeof fetch) => ({
  edgeBase: "https://edge.test", runtimeSecret: "s", ownerUid: "owner",
  workspaceId: "ws", sessionId: "ses", agentId: "a1", fetchImpl,
});

function reply(content: unknown, ok = true): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: ok ? 200 : 500,
    })) as unknown as typeof fetch;
}

describe("parseDifficulty", () => {
  it("认得出两个词，大小写与首尾空白不影响", () => {
    expect(parseDifficulty(" Simple\n")).toBe("simple");
    expect(parseDifficulty("HARD")).toBe("hard");
  });
  it("带尾巴也认（模型爱加标点）", () => {
    expect(parseDifficulty("hard.")).toBe("hard");
  });
  it("认不出来回 null，**不是默认 simple** —— 认不出说明这次分类没成功，该走回落", () => {
    expect(parseDifficulty("我觉得这个有点难")).toBeNull();
    expect(parseDifficulty("")).toBeNull();
  });
});

describe("modelForDifficulty", () => {
  it("simple 取最便宜、hard 取最贵（清单是从便宜到贵有序的）", () => {
    expect(modelForDifficulty("simple", MODELS)).toBe(CHEAP);
    expect(modelForDifficulty("hard", MODELS)).toBe(STRONG);
  });
  it("只有一款时回 null —— 「挑」这个动作没有意义，两档指向同一个 id", () => {
    expect(modelForDifficulty("hard", [CHEAP])).toBeNull();
    expect(modelForDifficulty("simple", [])).toBeNull();
  });
});

describe("pickAutoModel", () => {
  it("分类器说 hard 就用最贵那款", async () => {
    expect(await pickAutoModel(deps(reply("hard")), "写个爬虫", MODELS)).toBe(STRONG);
  });

  it("分类器说 simple 就用最便宜那款", async () => {
    expect(await pickAutoModel(deps(reply("simple")), "你好", MODELS)).toBe(CHEAP);
  });

  it("网关非 2xx → null（回落到今天的行为，不猜）", async () => {
    const f = (async () => new Response("nope", { status: 429 })) as unknown as typeof fetch;
    expect(await pickAutoModel(deps(f), "x", MODELS)).toBeNull();
  });

  it("fetch 抛异常 → null，且**不往外抛** —— 分类失败不该让 turn 失败", async () => {
    const f = (async () => { throw new Error("boom"); }) as unknown as typeof fetch;
    expect(await pickAutoModel(deps(f), "x", MODELS)).toBeNull();
  });

  it("答案认不出来 → null", async () => {
    expect(await pickAutoModel(deps(reply("大概算中等吧")), "x", MODELS)).toBeNull();
  });

  it("清单不足两款时**一次网关都不打**", async () => {
    const f = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    expect(await pickAutoModel(deps(f), "x", [CHEAP])).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it("用最便宜那款判，且带齐 workspace/session/agent 头 —— 这一次照样记账，不做暗扣", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "simple" } }] }));
    }) as unknown as typeof fetch;
    await pickAutoModel(deps(f), "x", MODELS);
    const { url, init } = seen!;
    expect(url).toBe("https://edge.test/llm/v1/chat/completions");
    const h = init.headers as Record<string, string>;
    expect(h["x-runtime-secret"]).toBe("s");
    expect(h["x-otto-on-behalf-of"]).toBe("owner");
    expect(h["x-otto-workspace"]).toBe("ws");
    expect(h["x-otto-session"]).toBe("ses");
    expect(h["x-otto-agent"]).toBe("a1");
    expect(JSON.parse(init.body as string).model).toBe(CHEAP);
  });

  it("超长正文按 CLASSIFY_MAX_CHARS 截断 —— 判难度不用读完整篇，截断同时封住成本与注入面积", async () => {
    let body: { messages: { content: string }[] } | null = null;
    const f = (async (_u: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ choices: [{ message: { content: "simple" } }] }));
    }) as unknown as typeof fetch;
    await pickAutoModel(deps(f), "长".repeat(5000), MODELS);
    expect(body!.messages[1]!.content.length).toBe(CLASSIFY_MAX_CHARS);
  });
});
