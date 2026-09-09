// 语音识别桥（#1176，ADR-0273）：主进程 ↔ native/MrOttoSpeech 的 NDJSON 通道。
// 形状照 simInputBridge（spawn 注入，整套逻辑在普通 vitest 里跑），但不是请求-响应：
// helper 主动吐事件（partial / final / status…），桥只负责编解码、行缓冲、崩溃后说出口。
import { describe, expect, it } from "vitest";
import {
  createSpeechBridge,
  decodeSpeechEvent,
  encodeSpeechCommand,
  type SpeechChild,
} from "../../src/main/speechBridge.js";
import type { SpeechEvent } from "../../src/shared/shellBridge.js";

function fakeChild() {
  const written: string[] = [];
  let onData: ((b: Buffer) => void) | null = null;
  let onExit: (() => void) | null = null;
  let killed = 0;
  const child: SpeechChild = {
    stdin: { write: (s) => void written.push(s) },
    stdout: { on: (_ev, cb) => void (onData = cb) },
    on: (_ev, cb) => void (onExit = cb),
    kill: () => void killed++,
  };
  return {
    child, written,
    get killed() { return killed; },
    emit: (o: object) => onData?.(Buffer.from(JSON.stringify(o) + "\n")),
    raw: (s: string) => onData?.(Buffer.from(s)),
    crash: () => onExit?.(),
  };
}

describe("encodeSpeechCommand / decodeSpeechEvent", () => {
  it("命令一行 JSON 带换行；start 带 locale 与 silenceMs", () => {
    expect(encodeSpeechCommand({ type: "start", locale: "zh-CN", silenceMs: 1500 })).toBe(
      '{"type":"start","locale":"zh-CN","silenceMs":1500}\n'
    );
    expect(encodeSpeechCommand({ type: "pause" })).toBe('{"type":"pause"}\n');
    // 上下文词表（#1196）：agent 名 / 成员名 / 开发常用英文词，识别器据此把「get up」认成 GitHub
    expect(encodeSpeechCommand({ type: "start", locale: "zh-CN", hints: ["GitHub", "管理员"] })).toBe(
      '{"type":"start","locale":"zh-CN","hints":["GitHub","管理员"]}\n'
    );
  });
  it("解七种事件；坏 JSON / 未知 type / 字段形状不对 → null", () => {
    expect(decodeSpeechEvent('{"type":"partial","text":"你好"}')).toEqual({ type: "partial", text: "你好" });
    expect(decodeSpeechEvent('{"type":"final","text":"你好啊"}')).toEqual({ type: "final", text: "你好啊" });
    expect(decodeSpeechEvent('{"type":"status","speech":"denied","mic":"authorized","onDevice":true,"locale":"zh-CN"}')).toEqual({
      type: "status", speech: "denied", mic: "authorized", onDevice: true, locale: "zh-CN", aec: null,
    });
    expect(decodeSpeechEvent('{"type":"status","speech":"notDetermined","mic":"notDetermined"}')).toEqual({
      type: "status", speech: "notDetermined", mic: "notDetermined", onDevice: null, locale: null, aec: null,
    });
    // 回声消除开没开（#1184）：开着 = 麦可以常开；缺席（旧 helper）= null，渲染层按半双工走
    expect(decodeSpeechEvent('{"type":"status","speech":"authorized","mic":"authorized","aec":true}')).toMatchObject({ aec: true });
    expect(decodeSpeechEvent('{"type":"level","value":0.42,"active":true}')).toEqual({ type: "level", value: 0.42, active: true });
    expect(decodeSpeechEvent('{"type":"level","value":"x"}')).toBeNull();
    expect(decodeSpeechEvent('{"type":"listening","on":true}')).toEqual({ type: "listening", on: true });
    expect(decodeSpeechEvent('{"type":"paused"}')).toEqual({ type: "paused" });
    expect(decodeSpeechEvent('{"type":"resumed"}')).toEqual({ type: "resumed" });
    expect(decodeSpeechEvent('{"type":"error","message":"没有麦克风"}')).toEqual({ type: "error", message: "没有麦克风" });
    expect(decodeSpeechEvent("{bad")).toBeNull();
    expect(decodeSpeechEvent('{"type":"nope"}')).toBeNull();
    expect(decodeSpeechEvent('{"type":"partial"}')).toBeNull();
    expect(decodeSpeechEvent('{"type":"status","speech":"weird","mic":"authorized"}')).toBeNull();
  });
});

describe("createSpeechBridge", () => {
  it("第一条命令才 spawn；命令原样写进 stdin；helper 吐的事件按行解码交给 onEvent（半行也攒得住）", () => {
    const f = fakeChild();
    let spawned = 0;
    const events: SpeechEvent[] = [];
    const bridge = createSpeechBridge({ binPath: "/x", spawn: () => { spawned++; return f.child; }, onEvent: (e) => events.push(e) });
    expect(spawned).toBe(0);
    expect(bridge.send({ type: "start", locale: "zh-CN" })).toBe(true);
    expect(spawned).toBe(1);
    expect(f.written).toEqual(['{"type":"start","locale":"zh-CN"}\n']);
    f.raw('{"type":"partial","te');
    expect(events).toEqual([]);
    f.raw('xt":"你"}\n{"type":"final","text":"你好"}\n');
    expect(events).toEqual([{ type: "partial", text: "你" }, { type: "final", text: "你好" }]);
    bridge.dispose();
    expect(f.killed).toBe(1);
  });

  it("解不开的行丢掉并记一笔，不影响后面的行", () => {
    const f = fakeChild();
    const events: SpeechEvent[] = [];
    const logs: string[] = [];
    const bridge = createSpeechBridge({ binPath: "/x", spawn: () => f.child, onEvent: (e) => events.push(e), log: (m) => logs.push(m) });
    bridge.send({ type: "status" });
    f.raw("garbage\n");
    f.emit({ type: "paused" });
    expect(events).toEqual([{ type: "paused" }]);
    expect(logs.some((l) => l.includes("garbage"))).toBe(true);
    bridge.dispose();
  });

  it("helper 崩了：报一条 error + listening:false 让界面知道麦掉了；下一条命令重新 spawn；超过 3 次不再起、send 回 false", () => {
    const children = [fakeChild(), fakeChild(), fakeChild(), fakeChild(), fakeChild()];
    let i = 0;
    const events: SpeechEvent[] = [];
    const bridge = createSpeechBridge({ binPath: "/x", spawn: () => children[i++]!.child, onEvent: (e) => events.push(e) });
    bridge.send({ type: "start", locale: "zh-CN" });
    children[0]!.crash();
    expect(events).toEqual([
      { type: "error", message: "语音识别 helper 退出了，重新开麦会再起一次" },
      { type: "listening", on: false },
    ]);
    expect(bridge.send({ type: "start", locale: "zh-CN" })).toBe(true);
    expect(i).toBe(2);
    children[1]!.crash();
    bridge.send({ type: "start", locale: "zh-CN" });
    children[2]!.crash();
    bridge.send({ type: "start", locale: "zh-CN" });
    children[3]!.crash();
    // 第 4 次崩溃之后不再起
    expect(bridge.send({ type: "start", locale: "zh-CN" })).toBe(false);
    expect(i).toBe(4);
    expect(events.at(-1)).toEqual({ type: "error", message: "语音识别 helper 反复退出，已停止重启——重开 app 再试" });
    bridge.dispose();
  });

  it("dispose 之后 send 回 false、不再 spawn；崩溃回调也不再报", () => {
    const f = fakeChild();
    const events: SpeechEvent[] = [];
    let spawned = 0;
    const bridge = createSpeechBridge({ binPath: "/x", spawn: () => { spawned++; return f.child; }, onEvent: (e) => events.push(e) });
    bridge.send({ type: "start", locale: "zh-CN" });
    bridge.dispose();
    f.crash();
    expect(events).toEqual([]);
    expect(bridge.send({ type: "start", locale: "zh-CN" })).toBe(false);
    expect(spawned).toBe(1);
  });
});
