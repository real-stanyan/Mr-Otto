// 语音消息的手机接线（#1492，ADR-0351，能热更新的那一半）。读源码钉住：
// ① MediaBubble 遇到 audio 走 AudioBubble（点播 / 转文字），正在传的走 AudioPendingBar；
// ② 放音走 expo-video 的无头播放器、同一时刻只放一条、组件卸载即停；
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
  it("expo-video 无头播放器、同一时刻只放一条、卸载即停、放完即停", () => {
    expect(src).toMatch(/createVideoPlayer\(url\)/);
    expect(src).toMatch(/if \(current !== null\) current\.stop\(\);/);
    expect(src).toMatch(/useEffect\(\(\) => \(\) => stop\(\), \[\]\);/);
    expect(src).toMatch(/addListener\("playToEnd", \(\) => stop\(\)\)/);
  });
  it("「转文字」展开 transcript，没有就说没有；不在本机识别", () => {
    expect(src).toMatch(/item\.transcript \?\? "这条语音没有文字/);
    expect(src).not.toMatch(/SFSpeech|OttoSpeech|startDictation/);
  });
  it("私聊里把 mine 递进去（自己的靠右、用自己的底色）", () => {
    expect(read("mobile/src/friends/FriendChatScreen.tsx")).toMatch(/<MediaBubble media=\{m\.media\} mine=\{mine\} \/>/);
  });
});

describe("只走热更新", () => {
  it("没有新的原生模块；录音 API 不在 otto-speech 里（那是下一次原生发版的事）", () => {
    const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies["expo-video"]).toBeDefined();
    expect(pkg.dependencies["expo-audio"]).toBeUndefined();
  });
});
