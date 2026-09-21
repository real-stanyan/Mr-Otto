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
// 都调它。
//
// Fix round 2（复审 Important）：round 1 在这里钉过「stopVoice(get) 出现 5 次」
// 「flushHeld(get) 出现 2 次」——这两条数的是**特定拼法出现几次**，不是机制本身。
// 加一条新的、合法的第六条离开路径（它也走 stopVoice）不会让任何一个数变，那两条
// 测试对此完全失明；反过来，一条**绕开** stopVoice、自己手写
// `voicePlayer?.stop(); stopMic(); set({ voice: null });` 的路径，也不会碰这两个
// 数字里的任何一个——它一次都不提 flushHeld 或 stopVoice，那两条断言原样保持绿色。
// 这正是原始 bug 的形状（setVoiceMic 记得发，其余路径各自平铺一遍收尾动作、没人
// 记得带上 flush），所以那两条计数测试已删，换成下面这条不认拼法认动作的。
describe("单一收口点：任何「离开语音」路径都绕不开 stopMic()，而 stopMic() 绕不开 flushHeld（fix round 2，#1281）", () => {
  it("flush 逻辑只有一份——holdStep 的 reset 只在 flushHeld 内部出现一次，不是每个调用点各写一遍", () => {
    const resets = src.match(/holdStep\(hold,\s*\{\s*type:\s*"reset"\s*\}/g) ?? [];
    expect(resets).toHaveLength(1);
  });
  it("丢弃逻辑同样只有一份——abandon 只在 abandonHeld 内部出现一次（#1289）", () => {
    const abandons = src.match(/holdStep\(hold,\s*\{\s*type:\s*"abandon"\s*\}/g) ?? [];
    expect(abandons).toHaveLength(1);
  });
  it("stopVoice 必须收 get 才能转发到 flushHeld；裸调用一处都不该有（漏传编译期已经会红，这里独立钉一遍）", () => {
    expect(src).toMatch(/function stopVoice\(get: \(\) => ChatState\): void \{/);
    expect(src.match(/\bstopVoice\(\s*\)/g)).toBeNull();
  });
  it("每一次 stopMic() 调用都紧跟在 flushHeld(get) 之后——一次都不能绕开", () => {
    // 判据是「动作」不是「拼法」：停麦（stopMic）是任何离开语音的路径都绕不开的
    // 动作——不停麦=麦一直听着，是那种一测（甚至一用）就会被发现的 bug；而
    // 「没发扣着的话」恰恰是那种不测就不会露馅的 bug（本条 issue 修的就是它）。
    // 所以钉住「停麦之前必须先 flush」这条因果关系，比数「stopVoice 这个名字
    // 被打了几次」更接近这次要保护的真相：新写一条根本不提 stopVoice/flushHeld、
    // 自己平铺 stopMic() 的路径，会让下面两个数不相等，而不是保持不变。
    //
    // 用「紧跟在下一行」而不是「函数体内某处」：本文件里两处真实调用
    // （stopVoice 内部、setVoiceMic(false) 分支）都是这个形状，源码里那行注释
    // 解释了为什么故意摆成这样；换成「同一个函数内」需要先会分函数边界，而
    // 这份源码不值得为了这条断言引入一个解析器。
    //
    // fix round 3：判据不能靠「分号」把定义行 `function stopMic(): void {`
    // 排除在外——本仓没有 lint/formatter（`npm test` 只是 `tsc --noEmit` +
    // `vitest run`），没有任何东西逼着新写的一次调用带分号；`stopMic()`（漏了
    // 分号，ASI 照样让它是合法语句）会被原来那条要求分号的正则直接漏数，
    // bare 与 guarded 两个数都不变、断言悄悄保持绿色，bug 原样复活却没有任何
    // 信号。改用「后面紧跟着的不是冒号」这条否定预测：定义行 `stopMic()` 后面
    // 紧接着的是`: void`的冒号，调用点后面无论是分号、换行、逗号还是别的都不是
    // 冒号——这样甄别的是"这是不是一次调用"而不是"这次调用有没有按格式写分号"。
    //
    // 残留：这条否定预测挡不住「表达式位置里紧跟着冒号」的形状——三元表达式
    // `cond ? stopMic() : x` 里 `stopMic()` 后面同样是 ` : x`，会被这条负向前瞻
    // 误判成定义行，两条正则都数不到它，既不算 bare 也不算 guarded。今天验过
    // 源码里没有这种写法；就算将来有，`window.otter.speechStop()` 全文件只在
    // stopMic() 内部这一处调用——真正要守住的关卡没有第二个入口，测试漏记一次
    // 调用不等于停麦本身失守。
    //
    // #1289：收口从此有**两种**——`flushHeld`（发出去：人确实说了，而且此刻还有地方
    // 可送）与 `abandonHeld`（清掉并说出口：会话在底下没了，requireReady() 必拒）。
    // 这条断言跟着放宽成「紧跟在**某一种**收口之后」，守的仍是同一句因果：停麦之前
    // 必须先给扣着的那句一个去向。放宽的是**认几种形状**，不是「可以不收口」——
    // 新写一条自己平铺 stopMic()、两种收口都不提的路径，照样让两个数不相等。
    const bareStopMicCalls = src.match(/\bstopMic\(\)(?!\s*:)/g) ?? [];
    const guardedByFlush = src.match(/(?:flushHeld\(get\)|abandonHeld\(set\));\s*\n\s*stopMic\(\)(?!\s*:)/g) ?? [];
    // 防呆：如果两条正则都失手匹配不到任何东西，0 === 0 会让上面那条 expect
    // 悄悄"通过"而实际什么都没钉住——先断言真的数到了东西
    expect(bareStopMicCalls.length).toBeGreaterThan(0);
    expect(guardedByFlush).toHaveLength(bareStopMicCalls.length);
  });
  it("closeCloudSession：flush 必须排在 workspaceCloudLeave() 之前——leave() 在主进程里同步清空当前房间，晚一步发送会被拒", () => {
    expect(src).toMatch(/stopVoice\(get\);\s*\n\s*void window\.otter\.workspaceCloudLeave\(\);/);
  });
});

// voiceOnCloudState 本身在 tests/renderer/voiceStore.test.ts 里**真跑**（停麦 / 通话
// 保留 / 自动重开 / denied 收掉 / 丢掉的原文进 mic.error）。这里钉的是那份真跑够不着
// 的一格：它到底有没有接在推送上，以及接在哪一侧。
describe("voiceOnCloudState 的接线（#1289）", () => {
  // 判顺序用 indexOf 不用「相隔至多 N 个字符」的正则：那种写法会被紧挨它的一段
  // 注释变长撞红（假阳），而这里真正要说的只有「在回调里、在 set 前面」
  const call = "get().voiceOnCloudState(status.sessionId, status.state);";
  const cb = "onCloudSessionStatus((status) => {";
  it("接在 onCloudSessionStatus 上——没有这一句，整个收口一次都不会发生，而且完全无声", () => {
    expect(src.indexOf(cb)).toBeGreaterThan(0);
    expect(src.indexOf(call)).toBeGreaterThan(src.indexOf(cb));
  });
  it("排在 set 之外、之前：副作用不写进 setState 的 updater（StrictMode 跑两遍），而且它读的 prev 正是这次 set 即将覆盖掉的那个 state", () => {
    // 这一句与回调开头之间不许出现 `set(`——出现了就说明它掉进 updater 里去了
    expect(src.slice(src.indexOf(cb), src.indexOf(call))).not.toMatch(/\bset\(/);
  });
});
