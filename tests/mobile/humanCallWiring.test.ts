// 人与人语音电话（#1534）在手机端的接线。判据在 shared（humanCall.test）真跑，这里读源码钉住：
// ① 打：FriendChatScreen 的电话钮「给本人」→ startHumanCall → 进 HumanCall 页；store 里先问 runtime（cloudClient.humanCall）再以 host 连中继 hc:<callId>；
// ② 接：callKit.ts 的 answer 事件里 chat = human 走 answerHumanCall（以 guest 连中继、麦好了说 ready），ringStore 把人送进 HumanCall 页而不是聊天页；
// ③ 系统界面上挂断 / 静音落到 hangUpHumanCall / setHumanMic；
// ④ 信令帖走 shared 的 encodeHc / decodeHc（base64url 一层），offer 等对端 ready 才发；通话期间 otto-speech 让出音频会话；
// ⑤ 原生依赖：react-native-webrtc + 它的 Expo 插件进了 package.json / app.json（= 要出原生包）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("call/humanCall.ts", () => {
  const src = read("mobile/src/call/humanCall.ts");
  it("打：先问 runtime，再以 host 连 hc:<callId>；接：以 guest 连，麦好了说 ready；offer 只在收到 ready 之后发", () => {
    expect(src).toMatch(/const r = await cloudClient\.humanCall\(callId, friendUid\);/);
    expect(src).toMatch(/connectRelay\(callId, "host"/);
    expect(src).toMatch(/connectRelay\(hc\.callId, "guest"/);
    expect(src).toMatch(/sendFrame\(\{ t: "ready" \}\)/);
    expect(src).toMatch(/case "ready": \{[\s\S]*?createOffer/);
    expect(src).toMatch(/channel: humanCallChannel\(callId\)/);
  });
  it("信令帖经 encodeHc / decodeHc 与 base64url；通话期间 otto-speech 让出音频会话，收尾还回去", () => {
    expect(src).toMatch(/b64encode\(new TextEncoder\(\)\.encode\(encodeHc\(f\)\)\)/);
    expect(src).toMatch(/decodeHc\(new TextDecoder\(\)\.decode\(bytes\)\)/);
    expect(src).toMatch(/setSessionManagedExternally\(true\)/);
    expect(src).toMatch(/setSessionManagedExternally\(false\)/);
  });
  it("接的人挂断时顺手收掉系统来电；结局由状态机写、资源在 ended 时收", () => {
    expect(src).toMatch(/OttoCall\?\.endCall\(c\.ringId\)/);
    expect(src).toMatch(/if \(next\.phase === "ended"\) teardown\(callId\);/);
  });
});

describe("CallKit / 来电那一条路", () => {
  it("callKit.ts：answer 事件里 human 走 answerHumanCall；end / mute 落到 hangUpHumanCall / setHumanMic", () => {
    const src = read("mobile/src/call/callKit.ts");
    expect(src).toMatch(/if \(c\.ring\.chat === "human"\) answerHumanCall\(c\.ring\);/);
    expect(src).toMatch(/if \(inHumanCall\(\)\) hangUpHumanCall\(e\.answered \? "user" : "declined"\);/);
    expect(src).toMatch(/if \(c\?\.ring\.chat === "human"\) setHumanMic\(!e\.muted\);/);
  });
  it("ringStore：human 的来电开 HumanCall 页，不预合成开场白", () => {
    const src = read("mobile/src/call/ringStore.ts");
    expect(src).toMatch(/if \(target\.kind === "human"\) \{[\s\S]*?name: "HumanCall", params: \{ callId: target\.callId, friendUid: target\.fromUid, incoming: true \}/);
    expect(src).toMatch(/ring\.chat !== "outreach" && ring\.chat !== "human"/);
  });
});

describe("私聊页 / 导航 / 原生依赖", () => {
  it("电话钮「给本人」→ startHumanCall + HumanCall 页；路由与屏都登记了", () => {
    expect(read("mobile/src/friends/FriendChatScreen.tsx")).toMatch(/void startHumanCall\(uid\);\s+navigation\.push\("HumanCall"/);
    expect(read("mobile/src/nav/types.ts")).toMatch(/HumanCall: \{ callId: string; friendUid: string; incoming: boolean \};/);
    expect(read("mobile/src/nav/RootNavigator.tsx")).toMatch(/<Root\.Screen name="HumanCall" component=\{HumanCallScreen\}/);
  });
  it("react-native-webrtc 与它的 Expo 插件在 package.json / app.json 里（= 原生包）", () => {
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).toHaveProperty("react-native-webrtc");
    expect(pkg.dependencies).toHaveProperty("@config-plugins/react-native-webrtc");
    const app = JSON.parse(read("mobile/app.json")) as { expo: { plugins: unknown[] } };
    expect(app.expo.plugins).toContain("@config-plugins/react-native-webrtc");
  });
});
