// 语音消息的手机接线（#1492，ADR-0351，能热更新的那一半）。读源码钉住：
// ① MediaBubble 遇到 audio 走 AudioBubble（点播 / 转文字），正在传的走 AudioPendingBar；
// ② 放音走 otto-speech 的原生放音器（#1631：expo-video 放完把共享会话留在激活态，锁屏来电就坏），没有语音
//    模块才退回 expo-video；同一时刻只放一条、组件卸载即停、放完即停；
// ③ 「转文字」展开的是发送方带来的 transcript，不在本机识别；
// ④ 没有新的原生模块（录音那一刀不在这一期）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("MediaBubble", () => {
  const src = read("mobile/src/media/MediaBubble.tsx");
  it("audio 走 AudioBubble；pending 的 audio 走 AudioPendingBar", () => {
    expect(src).toMatch(/if \(single !== undefined && single\.kind === "audio"\) return <AudioBubble item=\{single\} bucket=\{bucket\} mine=\{mine\} \/>;/);
    expect(src).toMatch(/if \(p\.kind === "audio"\) return <AudioPendingBar/);
  });
});

describe("AudioBubble", () => {
  const src = read("mobile/src/media/AudioBubble.tsx");
  it("原生放音器优先、expo-video 只是退路；同一时刻只放一条、卸载即停、放完即停", () => {
    expect(src).toMatch(/canPlayClipNatively\(\)\s*\?\s*playVoiceClip\(url, \{/);
    expect(src).toMatch(/end: \(\) => stop\(\)/);
    expect(src).toMatch(/: playWithExpoVideo\(url, stop\)/);
    expect(src).toMatch(/if \(current !== null\) current\.stop\(\);/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => stop\(\), \[\]\);/);
    expect(src).toMatch(/addListener\("playToEnd", \(\) => onDone\(\)\)/);
  });
  it("「转文字」展开 transcript，没有就说没有；不在本机识别", () => {
    expect(src).toMatch(/item\.transcript \?\? "这条语音没有文字/);
    expect(src).not.toMatch(/SFSpeech|OttoSpeech|startDictation/);
  });
  it("私聊里把 mine 递进去（自己的靠右、用自己的底色）", () => {
    expect(read("mobile/src/friends/FriendChatScreen.tsx")).toMatch(/<MediaBubble media=\{m\.media\} mine=\{mine\} \/>/);
  });
});

describe("voiceStore.playVoiceClip（#1631）", () => {
  const src = read("mobile/src/voice/voiceStore.ts");
  it("m4a 落盘交给原生放音器（和电话同一个，放完交还会话）；通话中不放", () => {
    expect(src).toMatch(/const clipAudio = fileAudio\("m4a"\);/);
    expect(src).toMatch(/new File\(audioDir, `\$\{id\}\.\$\{ext\}`\)/);
    expect(src).toMatch(/createHelperAudio\(bytes, clipAudio\)/);
    expect(src).toMatch(/if \(store\.get\(\)\.listen !== null\) \{\s*on\.fail\("正在通话，挂了再听"\);/);
    expect(src).not.toMatch(/from "expo-video"/);
  });
});

describe("只走热更新", () => {
  it("没有新的原生模块；录音 API 不在 otto-speech 里（那是下一次原生发版的事）", () => {
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["expo-video"]).toBeDefined();
    expect(pkg.dependencies["expo-audio"]).toBeUndefined();
  });
});
