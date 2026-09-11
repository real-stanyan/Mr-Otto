// 手机端进门那道闸：此刻画冷启动、登录、「设新密码」还是主界面。

import { describe, expect, it } from "vitest";
import { gateView, type GateInput } from "../../src/shared/mobileGate.js";

const base: GateInput = { booted: true, splashDone: true, hasSession: true, resetHold: false };

describe("gateView", () => {
  it("冷启动没做完、或进度条没到头：都还是冷启动", () => {
    expect(gateView({ ...base, booted: false })).toBe("splash");
    expect(gateView({ ...base, splashDone: false })).toBe("splash");
  });

  it("没有 session：登录", () => {
    expect(gateView({ ...base, hasSession: false })).toBe("signIn");
  });

  it("没有 session 时「按住」不起作用——那是上一次没走完的残留", () => {
    expect(gateView({ ...base, hasSession: false, resetHold: true })).toBe("signIn");
  });

  it("有 session 但新密码还没设：按住闸门，不进 app", () => {
    expect(gateView({ ...base, resetHold: true })).toBe("resetHold");
  });

  it("其余：进 app", () => {
    expect(gateView(base)).toBe("app");
  });
});
