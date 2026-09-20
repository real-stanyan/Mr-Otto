// store.ts 的语音那一段没法在 vitest 里真跑（要 window.otter、要 helper 的事件流）。
// 状态机本身在 utteranceHold.test.ts 里钉死了；这里钉的是接线里三条**漏了不会报错**的：
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../src/renderer/src/store.ts", import.meta.url), "utf8");

describe("store.ts：语音扣住/合并的接线（#1281）", () => {
  it("开关读的是 endpoint 这一处", () => {
    expect(src).toMatch(/modeOf\(.*"endpoint"\)/);
  });
  it("没开时 final 直接发，不经状态机（零额外延迟由构造保证）", () => {
    expect(src).toMatch(/===\s*"off"\)\s*sendSpoken\(/);
  });
  it("只有 on 才真扣（shadow 照问、不扣）", () => {
    expect(src).toMatch(/hold:\s*[A-Za-z]+\s*===\s*"on"/);
  });
  it("关麦时把扣着的那句发出去", () => {
    expect(src).toMatch(/type:\s*"reset"/);
  });
});

// Fix round 1（复审 Important）：spec 的收口时机是「关麦 / 换会话」，上面那组测试
// 只钉住了「关麦」（setVoiceMic(false)）。换会话/关云会话/重新进语音/离开语音通话/
// 通话被挂断这五条路径原来一句都没发——计时器还留着，之后拿旧闭包里的 sendSpoken
// 把这句话送进主进程那时已经加入的、可能是另一个房间。修法是单一收口点：
// flushHeld() 只实现一次，stopVoice()（这五条路径的共同祖先）与 setVoiceMic(false)
// 都调它。这里钉的是**机制**——只有一份实现、每条已知路径都接了它、顺序对——
// 不是钉某条路径这一次跑出来的文字。
describe("单一收口点：flushHeld 只有一份实现，五条离开语音的路径都接了它（fix round 1，#1281）", () => {
  it("flush 逻辑只有一份——holdStep 的 reset 只在 flushHeld 内部出现一次，不是每个调用点各写一遍", () => {
    const resets = src.match(/holdStep\(hold,\s*\{\s*type:\s*"reset"\s*\}/g) ?? [];
    expect(resets).toHaveLength(1);
  });
  it("stopVoice 必须收 get 才能转发到 flushHeld；裸调用一处都不该有（漏传编译期已经会红，这里独立钉一遍）", () => {
    expect(src).toMatch(/function stopVoice\(get: \(\) => ChatState\): void \{/);
    expect(src.match(/\bstopVoice\(\s*\)/g)).toBeNull();
  });
  it("五条已知的收尾路径——一条都没绕开 stopVoice(get)（openCloudSession / closeCloudSession / joinVoiceCall / leaveVoiceCall / voiceOnEvent 挂断分支）", () => {
    // 加第六条离开语音的路径时这个数要跟着改——逼着改的人想一遍「这条新路径
    // 是不是也该走 stopVoice」，而不是绕开它安静地漏发
    const calls = src.match(/\bstopVoice\(get\)/g) ?? [];
    expect(calls).toHaveLength(5);
  });
  it("setVoiceMic(false) 与 stopVoice 共用同一个 flushHeld，不是自己另一份实现", () => {
    const calls = src.match(/\bflushHeld\(get\)/g) ?? [];
    expect(calls).toHaveLength(2); // stopVoice 内部一次 + setVoiceMic(false) 一次
  });
  it("closeCloudSession：flush 必须排在 workspaceCloudLeave() 之前——leave() 在主进程里同步清空当前房间，晚一步发送会被拒", () => {
    expect(src).toMatch(/stopVoice\(get\);\s*\n\s*void window\.otter\.workspaceCloudLeave\(\);/);
  });
});
