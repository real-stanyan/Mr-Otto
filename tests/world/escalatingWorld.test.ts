import { describe, expect, it } from "vitest";
import { withSandboxEscalation } from "../../src/world/escalatingWorld.js";
import { SandboxDeniedError, isSandboxDenied, NO_SANDBOX } from "../../src/world/sandbox.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

// 沙箱升级环（issue #346）：沙箱拒绝 → 带原因二次审批 → 无沙箱重跑。
// v1 没有真沙箱，这组测试就是协议本身——v2 SandboxWorld 按契约抛
// SandboxDeniedError 即可接上。

const world = (exec: ExecutionWorld["exec"]): ExecutionWorld => ({
  fs: { read: async () => "", write: async () => {} },
  exec,
  http: { postJson: async () => ({}) },
});

const denying = (reason: string) =>
  world(async () => {
    throw new SandboxDeniedError(reason);
  });

describe("withSandboxEscalation", () => {
  it("沙箱拒绝 → 审批带失败原因 → 同意后无沙箱重跑", async () => {
    const asked: { command: string; reason: string }[] = [];
    let ranUnsandboxed = false;
    const w = withSandboxEscalation(
      denying("网络访问被策略禁止"),
      world(async () => {
        ranUnsandboxed = true;
        return { stdout: "ok", stderr: "", exitCode: 0 };
      }),
      {
        policy: { tier: "container" },
        requestEscalation: async (req) => {
          asked.push(req);
          return true;
        },
      }
    );

    const result = await w.exec("curl https://example.com");
    expect(result.stdout).toBe("ok");
    expect(ranUnsandboxed).toBe(true);
    expect(asked).toEqual([{ command: "curl https://example.com", reason: "网络访问被策略禁止" }]);
  });

  it("二次审批拒绝：原 SandboxDeniedError 上抛，不重跑", async () => {
    let ranUnsandboxed = false;
    const w = withSandboxEscalation(
      denying("写 /etc 被拦"),
      world(async () => {
        ranUnsandboxed = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      { policy: { tier: "container" }, requestEscalation: async () => false }
    );

    await expect(w.exec("rm /etc/hosts")).rejects.toSatisfy(isSandboxDenied);
    expect(ranUnsandboxed).toBe(false);
  });

  it("硬约束：policy 含拒读路径时升级分支被硬拒——不问人、不重跑（issue #346 ③）", async () => {
    let asked = false;
    let ranUnsandboxed = false;
    const w = withSandboxEscalation(
      denying("读 /secrets 被拦"),
      world(async () => {
        ranUnsandboxed = true;
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
      {
        policy: { tier: "container", denyReadPaths: ["/secrets"] },
        requestEscalation: async () => {
          asked = true;
          return true;
        },
      }
    );

    await expect(w.exec("cat /secrets/key")).rejects.toThrow(/不允许升级到无沙箱重跑/);
    expect(asked).toBe(false); // 硬拒 = 连弹窗都没有，不是"弹了然后拒"
    expect(ranUnsandboxed).toBe(false);
  });

  it("只认确定性标记：普通失败原样上抛，升级环不掺和（issue #346 ④）", async () => {
    let asked = false;
    const w = withSandboxEscalation(
      world(async () => {
        throw new Error("command not found: foo"); // 不是 SandboxDeniedError
      }),
      world(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
      {
        policy: { tier: "container" },
        requestEscalation: async () => {
          asked = true;
          return true;
        },
      }
    );

    await expect(w.exec("foo")).rejects.toThrow("command not found");
    expect(asked).toBe(false);
  });

  it("沙箱内成功：不问人、不重跑，结果原样返回", async () => {
    let asked = false;
    const w = withSandboxEscalation(
      world(async () => ({ stdout: "sandboxed ok", stderr: "", exitCode: 0 })),
      world(async () => ({ stdout: "should not run", stderr: "", exitCode: 0 })),
      {
        policy: { tier: "container" },
        requestEscalation: async () => {
          asked = true;
          return true;
        },
      }
    );
    expect((await w.exec("ls")).stdout).toBe("sandboxed ok");
    expect(asked).toBe(false);
  });

  it("external / none 档位建环 = 装配错误（external 已在外部沙箱内，无处可逃逸）", () => {
    const w = world(async () => ({ stdout: "", stderr: "", exitCode: 0 }));
    expect(() =>
      withSandboxEscalation(w, w, { policy: { tier: "external" }, requestEscalation: async () => true })
    ).toThrow(/container/);
    expect(() =>
      withSandboxEscalation(w, w, { policy: NO_SANDBOX, requestEscalation: async () => true })
    ).toThrow(/container/);
  });
});
