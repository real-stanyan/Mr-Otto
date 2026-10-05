// 系统来电里引擎「配置变了」（#1631，Recognizer 头注 ⑦）：在听就重起输入那条路，不悄悄停听。
// 真机 USB 日志：引擎起来 190ms 后 `iounit configuration changed > stopping the engine`，原先 externalSession
// 下直接 stop()——整通它照常说话、一个字都不识别，锁屏上人也没法再点麦克风。Swift 不进门禁，这里钉住源码形状。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../mobile/modules/otto-speech/ios/Recognizer.swift", import.meta.url), "utf8");

/** 「配置变了」那个观察者的回调体 */
function configChangeHandler(): string {
  const start = src.indexOf(".AVAudioEngineConfigurationChange");
  const end = src.indexOf("self.interrupted(\"声音设备变了", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("Recognizer：系统来电里配置变了", () => {
  it("在听 → restartAudio；没在听 → 手上那段当放完收掉", () => {
    const h = configChangeHandler();
    expect(h).toMatch(/if self\.externalSession \{[\s\S]*if self\.running \{\s*self\.restartAudio\(\)\s*\} else \{\s*self\.playback\.cut\(\)\s*\}/);
    expect(h).not.toMatch(/if self\.running \{ self\.stop\(\) \}/);
  });

  it("重起是同一次开麦的延续：不推 startToken、按新格式重装 tap、没开成不报 error", () => {
    const body = src.slice(src.indexOf("private func restartAudio()"));
    const fn = body.slice(0, body.indexOf("\n  }\n") + 4);
    expect(fn).not.toMatch(/startToken \+= 1/);
    expect(fn).toMatch(/engine\.inputNode\.removeTap\(onBus: 0\)/);
    expect(fn).toMatch(/guard beginAudio\(quiet: true\) else \{/);
    // 放音停下记着：成了从头再放、没成当放完收掉
    expect(fn).toMatch(/let held = playback\.suspend\(\)/);
    expect(fn).toMatch(/if held \{ playback\.resume\(\) \}/);
    expect(fn).toMatch(/if held \{ playback\.cut\(\) \}/);
  });

  it("限次：一秒内第三次就不再重起，悄悄停听", () => {
    expect(src).toMatch(/restartsInWindow = now - restartWindowStart < 1000 \? restartsInWindow \+ 1 : 1/);
    expect(src).toMatch(/guard restartsInWindow <= 2 else \{[\s\S]*?stop\(\)/);
  });

  it("quiet 开麦没开成只报 listening 关", () => {
    expect(src).toMatch(/self\.emit\(quiet \? Event\(type: "listening", on: false\) : Event\(type: "error", message: message\)\)/);
  });
});
