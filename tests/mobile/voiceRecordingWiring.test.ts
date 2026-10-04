// 语音消息的录音那一刀（#1492，ADR-0351 第 5 条）——动了 otto-speech 原生，**要出新原生包才生效**。读源码钉住：
// ① Swift：录音在现有的 tap 里顺手写 m4a（第 0 声道折成 mono、不看 paused、写在自己的队列上）；stop() 关文件但
//    留着 URL，stopRecording 排在 stop 之后也取得到；② 模块注册了 startRecording / stopRecording；③ JS 那侧对老原生包
//    （没有这两条命令）退回发文字；④ 朋友私聊松手：录到了 ≥1 秒且没 @ 智能体 → 发语音条、转写随消息走。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("otto-speech 录音", () => {
  const swift = read("mobile/modules/otto-speech/ios/Recognizer.swift");
  it("在 tap 里写 m4a：mono 拷贝、不看 paused、写队列", () => {
    expect(swift).toMatch(/if let file = self\.recordFile, let copy = AVAudioPCMBuffer\(pcmFormat: mono/);
    expect(swift).toMatch(/self\.recordQueue\.async \{\s*do \{\s*try file\.write\(from: copy\)/);
    expect(swift).toMatch(/AVAudioFile\(forWriting: url, settings: settings, commonFormat: \.pcmFormatFloat32, interleaved: false\)/);
    expect(swift).toMatch(/AVFormatIDKey: kAudioFormatMPEG4AAC/);
  });
  it("stop() 关文件留 URL；stopRecording(keep) 回 uri / durationMs / bytes，不要就删文件", () => {
    expect(swift).toMatch(/engine\.inputNode\.removeTap\(onBus: 0\)\s*closeRecordFile\(\)/);
    expect(swift).toMatch(/func stopRecording\(keep: Bool\) -> \[String: Any\]\?/);
    expect(swift).toMatch(/return \["uri": url\.absoluteString, "durationMs": durationMs, "bytes": bytes\]/);
    expect(swift).toMatch(/if !keep \{\s*try\? FileManager\.default\.removeItem\(at: url\)/);
  });
  it("开麦之前就说要录：start 起来那一刻补开文件", () => {
    expect(swift).toMatch(/if wantRecording, recordFile == nil \{ openRecordFile\(rate: format\.sampleRate\) \}/);
  });
  it("模块注册了两条命令，JS 声明对得上", () => {
    const mod = read("mobile/modules/otto-speech/ios/OttoSpeechModule.swift");
    expect(mod).toMatch(/AsyncFunction\("startRecording"\)/);
    expect(mod).toMatch(/AsyncFunction\("stopRecording"\) \{ \(keep: Bool\) -> \[String: Any\]\? in/);
    const ts = read("mobile/modules/otto-speech/index.ts");
    expect(ts).toMatch(/startRecording\(\): Promise<void>;/);
    expect(ts).toMatch(/stopRecording\(keep: boolean\): Promise<\{ uri: string; durationMs: number; bytes: number \} \| null>;/);
  });
});

describe("JS 那一侧", () => {
  it("voiceStore：老原生包没有这两条命令 = 不录 / 回 null", () => {
    const src = read("mobile/src/voice/voiceStore.ts");
    expect(src).toMatch(/typeof speech\.startRecording !== "function"\) return;/);
    expect(src).toMatch(/typeof speech\.stopRecording !== "function"\) return null;/);
  });
  it("朋友私聊松手：录到了 ≥1 秒且没 @ 智能体 → 发语音条带转写；否则照旧发文字", () => {
    const src = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(src).toMatch(/startDictation\(setHoldText, \(m\) => setNote\(m\)\);\s*startVoiceRecording\(\);/);
    expect(src).toMatch(/const rec = await stopVoiceRecording\(ok\);/);
    // #1523：两条车道（我的、朋友公开给我的）任一被 @ 都发文字，判据合在 laneTargetsOf
    expect(src).toMatch(/if \(rec !== null && rec\.durationMs >= 1000 && laneTargetsOf\(trimmed\) === null\)/);
    expect(src).toMatch(/kind: "audio", uri: rec\.uri, mediaType: "audio\/mp4"/);
    expect(src).toMatch(/toast\(rec !== null && rec\.durationMs < 1000 \? "说话时间太短" : "没听清，按住再说一遍"\)/);
  });
  it("动了原生：runtimeVersion 进到 2，麦克风文案提到语音消息", () => {
    const app = JSON.parse(read("mobile/app.json")) as { expo: { runtimeVersion: string; ios: { infoPlist: Record<string, string> } } };
    expect(app.expo.runtimeVersion).toBe("2");
    expect(app.expo.ios.infoPlist.NSMicrophoneUsageDescription).toMatch(/语音消息/);
  });
});
