// 项目栏大标题底下那一行：到自己那台电脑的加密连接此刻怎么样。
// 项目栏与账号页读同一份，判据只能有一份。

import { describe, expect, it } from "vitest";
import { linkStatus } from "../../src/shared/linkStatus.js";

describe("linkStatus", () => {
  it("握手完成：已连上", () => {
    expect(linkStatus(true, false, false)).toEqual({ tone: "ok", text: "已连上你的 Mac" });
    expect(linkStatus(true, true, true)).toEqual({ tone: "ok", text: "已连上你的 Mac" });
  });

  it("断了但还在宽限期里：当抖动看，说「重连中」，不说「断开了」", () => {
    expect(linkStatus(false, false, true)).toEqual({ tone: "warn", text: "重连中…" });
    expect(linkStatus(false, false, false)).toEqual({ tone: "warn", text: "重连中…" });
  });

  it("过了宽限期、手里还有断线前那份：说清下面的内容是旧的", () => {
    expect(linkStatus(false, true, true)).toEqual({ tone: "warn", text: "断开了 —— 下面是断线前的" });
  });

  it("过了宽限期、什么都没有：只说断开了", () => {
    expect(linkStatus(false, true, false)).toEqual({ tone: "warn", text: "断开了" });
  });
});
