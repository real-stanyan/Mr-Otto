// 适配层：四套枚举 → 一个 FaceState。这里全是**优先级**的断言，而优先级是有法理的
// 决定（见 sessionOrb.ts 与 ADR-0250），不是随手排的顺序。

import { describe, expect, it } from "vitest";
import type { AgentPhaseInput } from "@/lib/agentPhase.js";
import { faceStateFor, SLEEP_AFTER_MS } from "@/lib/ottoFace/adapter.js";

const phase = (over: Partial<AgentPhaseInput> = {}): AgentPhaseInput => ({
  hasApproval: false, compacting: false, streamingText: "", tool: null, ...over,
});
const call = (name: string) => ({ id: "t1", name, args: {} }) as AgentPhaseInput["tool"];

describe("faceStateFor", () => {
  it("dormant 压过一切——连不上的时候，下面每一格读出来都是过期快照", () => {
    expect(faceStateFor({
      running: true, dormant: true, errorClass: "fatal",
      voice: "speaking", openTurn: { state: "queued" }, phase: phase({ hasApproval: true }),
    })).toBe("frozen");
  });

  it("queued 排在 agentPhase 之前", () => {
    // agentPhase() 自己的注释说它的调用前提是「turn 在跑」；而 queued 的定义就是
    // 一个 token 都还没跑。顺序反了的话，排队中的 agent 会显示成「思考中」——
    // 正是 ADR-0250 不许画的那个撒谎的勾
    expect(faceStateFor({ running: false, openTurn: { state: "queued" }, phase: phase() })).toBe("queued");
  });

  it("通话中的说法压过 turn 状态", () => {
    // 人此刻看的是通话那一屏，那里的语义才对得上
    expect(faceStateFor({ running: true, voice: "speaking", phase: phase({ streamingText: "x" }) })).toBe("speaking");
    expect(faceStateFor({ running: true, voice: "listening", phase: phase() })).toBe("listening");
    expect(faceStateFor({ running: true, voice: "thinking", phase: phase() })).toBe("thinking");
    // idle（没在听）不该劫持，交给下面的规则
    expect(faceStateFor({ running: false, voice: "idle" })).toBe("idle");
  });

  it("agentPhase 的七个 orb 一个不落地映射过来", () => {
    expect(faceStateFor({ running: true, phase: phase({ hasApproval: true }) })).toBe("waiting");
    expect(faceStateFor({ running: true, phase: phase({ waitingFor: "cloud" }) })).toBe("waiting");
    expect(faceStateFor({ running: true, phase: phase({ compacting: true }) })).toBe("weaving");
    expect(faceStateFor({ running: true, phase: phase({ tool: call("read_file") }) })).toBe("searching");
    expect(faceStateFor({ running: true, phase: phase({ tool: call("bash") }) })).toBe("working");
    expect(faceStateFor({ running: true, phase: phase({ streamingText: "答" }) })).toBe("answering");
    expect(faceStateFor({ running: true, phase: phase() })).toBe("thinking");
  });

  it("有挂起审批时，turn 没跑也要走 agentPhase", () => {
    // agentPhase 的第一分支就是 hasApproval；不带这个条件的话，
    // 「停在原地等人」这一格在 turn 已经收口之后就消失了
    expect(faceStateFor({ running: false, phase: phase({ hasApproval: true }) })).toBe("waiting");
  });

  it("错误分类各归各位，rate-limit 不与 fatal 混", () => {
    expect(faceStateFor({ running: true, errorClass: "fatal" })).toBe("failed");
    expect(faceStateFor({ running: true, errorClass: "rate-limit" })).toBe("ratelimit");
    // retryable 是瞬态，没有自己的脸——它该继续显示在跑
    expect(faceStateFor({ running: true, errorClass: "retryable", phase: phase() })).toBe("thinking");
  });

  it("后台任务的两种终态各有一张脸", () => {
    expect(faceStateFor({ running: false, background: "ready" })).toBe("done");
    expect(faceStateFor({ running: false, background: "failed" })).toBe("failed");
    // running 的后台任务不劫持——那只 agent 自己可能正闲着
    expect(faceStateFor({ running: false, background: "running" })).toBe("idle");
  });

  it("闲够久了才睡", () => {
    expect(faceStateFor({ running: false })).toBe("idle");
    expect(faceStateFor({ running: false, idleMs: SLEEP_AFTER_MS - 1 })).toBe("idle");
    expect(faceStateFor({ running: false, idleMs: SLEEP_AFTER_MS })).toBe("sleep");
  });

  it("什么都不给也有答案，不会抛也不会回 undefined", () => {
    // 花名册上一行拿不到投影是正常状态（数据源还没到位，#1282），
    // 那一行该画「空闲」而不是空白或崩掉
    expect(faceStateFor({ running: false })).toBe("idle");
  });
});
