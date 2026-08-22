import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSend, type SendTarget } from "../../src/main/rendererPush.js";

interface FakeWindow {
  target: SendTarget;
  sent: unknown[][];
  killWindow(): void;
  killWebContents(): void;
}

function fakeWindow(): FakeWindow {
  const sent: unknown[][] = [];
  let winDead = false;
  let wcDead = false;
  return {
    sent,
    killWindow: () => (winDead = true),
    killWebContents: () => (wcDead = true),
    target: {
      isDestroyed: () => winDead,
      webContents: {
        isDestroyed: () => wcDead,
        send: (channel, ...args) => void sent.push([channel, ...args]),
      },
    },
  };
}

describe("createSend", () => {
  it("窗口活着 → 原样转发 channel 和全部参数", () => {
    const win = fakeWindow();
    createSend(win.target)("otter:event", { a: 1 }, "b");
    expect(win.sent).toEqual([["otter:event", { a: 1 }, "b"]]);
  });

  it("窗口已销毁 → 静默丢弃，不抛（turn 不该因为用户关了窗就失败）", () => {
    const win = fakeWindow();
    win.killWindow();
    expect(() => createSend(win.target)("otter:event", {})).not.toThrow();
    expect(win.sent).toEqual([]);
  });

  it("窗口还在但 webContents 先没了 → 同样丢弃（只查 window 挡不住这一种）", () => {
    const win = fakeWindow();
    win.killWebContents();
    createSend(win.target)("otter:event", {});
    expect(win.sent).toEqual([]);
  });

  it("每次调用都现查死活——不是构造时查一次就定了", () => {
    const win = fakeWindow();
    const send = createSend(win.target);
    send("otter:event", 1);
    win.killWindow();
    send("otter:event", 2);
    expect(win.sent).toEqual([["otter:event", 1]]);
  });

  it("没有参数的通知也发得出去", () => {
    const win = fakeWindow();
    createSend(win.target)("otter:ping");
    expect(win.sent).toEqual([["otter:ping"]]);
  });
});

function fakeWin(destroyed = false): SendTarget & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: { isDestroyed: () => destroyed, send: (...a: unknown[]) => { sent.push(a); } },
  };
}

describe("createSend 多目标", () => {
  it("推给所有活着的窗口,已销毁的静默跳过", () => {
    const a = fakeWin(), dead = fakeWin(true), b = fakeWin();
    const send = createSend(a, dead, b);
    send("ch", 1);
    expect(a.sent).toEqual([["ch", 1]]);
    expect(b.sent).toEqual([["ch", 1]]);
    expect(dead.sent).toEqual([]);
  });
});

describe("主进程里不许有裸 send", () => {
  // 门禁只跑 vitest。「所有 send 都走统一出口」这条规矩不写成测试，
  // 下一个人照旧会在新通道上写 win.webContents.send —— 这个 bug 上次
  // 就是这么只修了一半的（issue #53）
  it("src/main 里除了 rendererPush.ts 自己，没有 webContents.send 调用", () => {
    const dir = join(process.cwd(), "src/main");
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name === "rendererPush.ts") continue;
      const src = readFileSync(join(dir, name), "utf8");
      for (const line of src.split("\n")) {
        // 注释里提这个名字是允许的（index.ts 里就有一条"别在别处直接…"的告诫）
        if (/\bwebContents\s*\.\s*send\s*\(/.test(line) && !line.trimStart().startsWith("//")) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
