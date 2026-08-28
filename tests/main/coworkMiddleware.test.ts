import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoworkMiddleware } from "../../src/main/coworkMiddleware.js";
import { appendRecord, readRecords } from "../../src/main/coworkLogFile.js";
import type { ToolCallContext, ToolOutcome } from "../../src/loop/middleware.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

// 同一个文件夹里的两只水獭（issue #658）：记账 + 按需注入 + 文件级的闸。
// 重点是**只有撞上同一个文件才拦**——不同文件必须畅通无阻。

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "otto-cowork-mw-"));
});
afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
});

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const ctx = (name: string, args: unknown): ToolCallContext => ({
  call: { id: "c1", name, args },
  tool: undefined,
  world,
  sessionId: "me",
});

const ok = (output = "干完了"): ToolOutcome => ({ status: "ok", output });

/** 时钟可控：拦不拦全看时间先后，真时钟会让测试变成掷骰子 */
const mw = (now: () => number, title: string | null = "给客户写提案") =>
  createCoworkMiddleware({
    workspace: ws,
    sessionId: "me",
    isMyFamily: (id) => id === "me" || id === "我的子会话",
    title: () => title,
    now,
    tzOffsetMinutes: () => 0,
  });

describe("记账", () => {
  it("写成之后往本子里留一条：谁、动了哪个文件、为什么", async () => {
    const m = mw(() => 1000);
    await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x", reason: "压到三行" }), async () => ok());
    const got = await readRecords(ws);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ sessionId: "me", path: "提案.md", reason: "压到三行" });
  });

  it("模型没写 reason → 退回会话标题（「在做什么」比什么都不写强）", async () => {
    const m = mw(() => 1000);
    await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ok());
    expect((await readRecords(ws))[0]!.reason).toBe("给客户写提案");
  });

  it("写盘失败/被拒不留痕 —— 本子里只该有真发生过的改动", async () => {
    const m = mw(() => 1000);
    await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ({
      status: "denied",
      output: "用户拒绝",
    }));
    expect(await readRecords(ws)).toEqual([]);
  });

  it("围栏外的文件不记账，也不拦", async () => {
    const m = mw(() => 1000);
    const out = await m(ctx("write_file", { path: "/etc/hosts", content: "x" }), async () => ok());
    expect(out.status).toBe("ok");
    expect(await readRecords(ws)).toEqual([]);
  });

  it("别的工具一律直通", async () => {
    const m = mw(() => 1000);
    const out = await m(ctx("bash", { cmd: "ls" }), async () => ok("列出来了"));
    expect(out.output).toBe("列出来了");
    expect(await readRecords(ws)).toEqual([]);
  });
});

describe("文件级的闸", () => {
  it("别人在我看过之后动了同一个文件 → 拦一次，工具压根不执行", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "客户要删第三段" }, 0);
    const m = mw(() => 1000);
    let ran = false;
    const out = await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => {
      ran = true;
      return ok();
    });
    expect(ran).toBe(false); // 短路：文件一个字节都没动
    expect(out.status).toBe("error");
    expect(out.output).toContain("别的水獭");
    expect(out.output).toContain("客户要删第三段");
    expect(out.output).toContain("read_file");
  });

  it("**不同文件一律放行** —— 一个写提案一个写预算，这才是这套东西的重点", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "改了" }, 0);
    const m = mw(() => 1000);
    const out = await m(ctx("write_file", { path: join(ws, "预算.md"), content: "x" }), async () => ok());
    expect(out.status).toBe("ok");
  });

  it("拦一次就够：模型坚持再写就放它过去，不把协作问题变成死循环", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "改了" }, 0);
    const m = mw(() => 1000);
    const call = () => m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ok());
    expect((await call()).status).toBe("error");
    expect((await call()).status).toBe("ok");
  });

  it("先读一遍再写就不拦了 —— 这正是拦下来时要求它做的事", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "改了" }, 0);
    let clock = 1000;
    const m = mw(() => clock);
    await m(ctx("read_file", { path: join(ws, "提案.md") }), async () => ok("文件内容"));
    clock = 2000;
    const out = await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ok());
    expect(out.status).toBe("ok");
  });

  it("同家族（子会话 / SideChat）不互拦：共享工作区是故意的", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "我的子会话", path: "提案.md", reason: "帮忙改的" }, 0);
    const m = mw(() => 1000);
    const out = await m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ok());
    expect(out.status).toBe("ok");
  });

  it("我自己刚写过的文件，再写不拦", async () => {
    const m = mw(() => 1000);
    const call = () => m(ctx("write_file", { path: join(ws, "提案.md"), content: "x" }), async () => ok());
    expect((await call()).status).toBe("ok");
    expect((await call()).status).toBe("ok");
  });
});

describe("按需注入", () => {
  it("读到别人动过的文件，结果尾巴上补一句谁改的、为什么", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "压到三行" }, 0);
    const m = mw(() => 1000);
    const out = await m(ctx("read_file", { path: join(ws, "提案.md") }), async () => ok("正文"));
    expect(out.output).toContain("正文");
    expect(out.output).toContain("别的水獭");
    expect(out.output).toContain("压到三行");
  });

  it("没人动过就一个字不加 —— 沉默是默认，不给模型加噪音", async () => {
    const m = mw(() => 1000);
    const out = await m(ctx("read_file", { path: join(ws, "提案.md") }), async () => ok("正文"));
    expect(out.output).toBe("正文");
  });

  it("读失败不注入也不记账", async () => {
    await appendRecord(ws, { ts: 500, sessionId: "别的水獭", path: "提案.md", reason: "改了" }, 0);
    const m = mw(() => 1000);
    const out = await m(ctx("read_file", { path: join(ws, "提案.md") }), async () => ({
      status: "error",
      output: "ENOENT",
    }));
    expect(out.output).toBe("ENOENT");
  });
});
