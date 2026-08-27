// 「工具产出了图，日志里却没有它」那条链（#594 / ADR-0144）。
//
// 分两层盯，理由同 engine.diffStat.test.ts：单独测中间件只证明它自己算得对，
// 证明不了**装配之后字节真的变成了日志里的 ref**。所以下半段跑真 LoopEngine +
// 真 AttachmentStore + 真中间件，只有工具和模型是假的。
//
// 上半段那几条盯的是降级：落库失败、失败的调用、没装中间件 —— 它们的共同点是
// "少一张卡"必须换成"工具调用照常成功"，而不是反过来。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { rmSync } from "node:fs";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createImageIntakeMiddleware } from "../../src/main/imageIntake.js";
import { runPipeline } from "../../src/loop/middleware.js";
import type { ToolCallContext, ToolOutcome } from "../../src/loop/middleware.js";
import type { Tool, ToolImage } from "../../src/tools/tool.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { ToolResultEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

const png = (tag: number): ToolImage => ({
  data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]),
  mimeType: "image/png",
});

const WORLD: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 出图工具。images 由每个用例给，output 恒定——断言"output 一个字没变"要用 */
function imageTool(images: readonly ToolImage[]): Tool {
  return {
    def: { name: "draw", description: "", parameters: {} },
    requiresApproval: false,
    async run() {
      return { output: "画好了", images };
    },
  };
}

let dir: string;
let store: AttachmentStore;
beforeEach(() => {
  dir = tempDir("otto-image-intake-");
  store = new AttachmentStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 只跑中间件那一层：ctx 只用得到 call.name */
function pipeOnce(
  outcome: ToolOutcome,
  toolName = "draw",
): Promise<ToolOutcome> {
  const ctx = { call: { id: "c1", name: toolName, args: {} } } as ToolCallContext;
  return runPipeline([createImageIntakeMiddleware(store)], async () => outcome, ctx);
}

describe("imageIntake 中间件", () => {
  it("图入库，outcome 换上 ref，output 一个字不动", async () => {
    const out = await pipeOnce({ status: "ok", output: "画好了", images: [png(1)] });
    expect(out.output).toBe("画好了");
    expect(out.imageRefs).toHaveLength(1);
    const ref = out.imageRefs![0]!;
    expect(ref.id).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(ref.mediaType).toBe("image/png");
    // 字节真的在库里 —— 只有这一条能证明 ref 不是凭空造的
    expect(new Uint8Array(store.read(ref.id))).toEqual(png(1).data);
  });

  it("ref 的名字带工具名：时间线上说得出这张图是谁产出的", async () => {
    const out = await pipeOnce({ status: "ok", output: "", images: [png(2)] }, "text_to_image");
    expect(out.imageRefs![0]!.name).toBe("text_to_image.png");
  });

  it("认不出的格式跳过这一张，其余照落，调用照常成功", async () => {
    const bad: ToolImage = { data: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" };
    const out = await pipeOnce({ status: "ok", output: "画好了", images: [bad, png(3)] });
    expect(out.status).toBe("ok");
    expect(out.output).toBe("画好了");
    expect(out.imageRefs).toHaveLength(1);
  });

  it("一张都落不进去时不挂 imageRefs（而不是挂个空数组）", async () => {
    const bad: ToolImage = { data: new Uint8Array([1, 2, 3, 4]), mimeType: "image/png" };
    const out = await pipeOnce({ status: "ok", output: "画好了", images: [bad] });
    expect(out.imageRefs).toBeUndefined();
  });

  it("失败/被拒的调用不留图：那次调用没有『产出』可言", async () => {
    for (const status of ["error", "denied"] as const) {
      const out = await pipeOnce({ status, output: "不行", images: [png(4)] });
      expect(out.imageRefs).toBeUndefined();
    }
  });
});

describe("装配之后：字节 → 日志里的 ref", () => {
  function engineWith(images: readonly ToolImage[], middleware: boolean) {
    const store2 = new EventStore(":memory:");
    const script: ModelReply[] = [
      { content: "", toolCalls: [{ id: "t1", name: "draw", args: {} }] },
      { content: "好了" },
    ];
    let i = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        const reply = script[i++];
        if (!reply) throw new Error("脚本用完了还在调");
        return reply;
      },
    };
    const engine = new LoopEngine({
      store: store2,
      adapter,
      tools: [imageTool(images)],
      world: WORLD,
      sessionId: "s1",
      ...(middleware ? { middlewares: [createImageIntakeMiddleware(store)] } : {}),
    });
    return { engine, store: store2 };
  }

  const resultOf = (s: EventStore): ToolResultEvent =>
    s.load("s1").find((e): e is ToolResultEvent => e.type === "tool_result")!;

  it("tool_result.images 落的是 ref，字节在附件库里", async () => {
    const { engine, store: log } = engineWith([png(5)], true);
    await engine.runTurn("画一张");
    const result = resultOf(log);
    expect(result.status).toBe("ok");
    expect(result.images).toHaveLength(1);
    expect(new Uint8Array(store.read(result.images![0]!.id))).toEqual(png(5).data);
    // 日志里绝不能出现字节本身：撑爆 append-only 日志是删不掉的
    expect(JSON.stringify(result)).not.toContain("137,80,78,71");
  });

  it("没装中间件 = 静默降级：字段整个不出现，output 照旧", async () => {
    const { engine, store: log } = engineWith([png(6)], false);
    await engine.runTurn("画一张");
    const result = resultOf(log);
    expect(result.status).toBe("ok");
    expect(result.output).toBe("画好了");
    expect("images" in result).toBe(false);
  });

  it("工具没出图时 tool_result 的形状与从前逐字节一致", async () => {
    const { engine, store: log } = engineWith([], true);
    await engine.runTurn("说句话");
    expect("images" in resultOf(log)).toBe(false);
  });
});
