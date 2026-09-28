// 回电铃声（#1411，spec §3.4）：APNs 的通知铃声上限 30 秒，超了系统换成默认提示音——这件事不报错。
import { describe, expect, it } from "vitest";
import { RATE, ringtoneSamples, wavBytes } from "../../scripts/make-ringtone.mjs";

describe("make-ringtone", () => {
  it("总长 20~30 秒、不削波", () => {
    const s = ringtoneSamples();
    expect(s.length / RATE).toBeLessThanOrEqual(30);
    expect(s.length / RATE).toBeGreaterThan(20);
    let peak = 0;
    for (const v of s) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.1);
    expect(peak).toBeLessThan(1);
  });
  it("WAV 头：RIFF / WAVE、PCM 单声道 16 位、数据长度对得上", () => {
    const s = ringtoneSamples();
    const b = wavBytes(s);
    expect(b.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(b.subarray(8, 12).toString("latin1")).toBe("WAVE");
    expect(b.readUInt16LE(20)).toBe(1);
    expect(b.readUInt16LE(22)).toBe(1);
    expect(b.readUInt32LE(24)).toBe(RATE);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.readUInt32LE(40)).toBe(s.length * 2);
  });
});
