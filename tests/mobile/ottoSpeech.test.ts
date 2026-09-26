// 手机端语音原生模块（#1356 A4，ADR-0320）与桌面 MrOttoSpeech 对拍。Swift 不进门禁（这里没有 iOS 工具链），
// 于是「照搬桌面」这句话由这里钉住：断句与能量门逐字相同、事件字段表相同、JS 声明的函数与 Swift 注册的
// 函数一一对上、Info.plist 的两句授权说明在。改了桌面那两份纯逻辑而手机不跟（或反过来），这里红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");
const DESKTOP = "native/MrOttoSpeech/Sources/MrOttoSpeech";
const MOBILE = "mobile/modules/otto-speech";

/** `struct Event` 那一块里声明的字段名（排序后）。只认两格缩进的成员声明：手机那份 `dictionary`
    里的局部 `var d` 是四格，不是字段；`dictionary` 本身是算出来的属性，也不算 */
function eventFields(src: string): string[] {
  const start = src.indexOf("struct Event");
  const end = src.indexOf("\n}", start);
  const block = src.slice(start, end);
  return [...block.matchAll(/^ {2}(?:let|var) (\w+):/gm)].map((m) => m[1]!).filter((n) => n !== "dictionary").sort();
}

describe("otto-speech 原生模块与桌面 MrOttoSpeech 对拍", () => {
  it("能量门 Level.swift 逐字相同", () => {
    expect(read(`${MOBILE}/ios/Level.swift`)).toBe(read(`${DESKTOP}/Level.swift`));
  });

  it("断句（utteranceLooksFinished + Endpointer）从那段注释起到末尾逐字相同", () => {
    const marker = "/// 一句是不是像说完了";
    const desktop = read(`${DESKTOP}/Protocol.swift`);
    const mobile = read(`${MOBILE}/ios/Endpointer.swift`);
    expect(desktop.includes(marker)).toBe(true);
    expect(mobile.includes(marker)).toBe(true);
    expect(mobile.slice(mobile.indexOf(marker))).toBe(desktop.slice(desktop.indexOf(marker)));
  });

  it("事件字段表相同（JS 那侧用同一个 speechEventOf 验）", () => {
    const mobile = eventFields(read(`${MOBILE}/ios/Event.swift`));
    expect(mobile).toEqual(eventFields(read(`${DESKTOP}/Protocol.swift`)));
    expect(mobile).toContain("aec");
  });

  it("JS 声明的每个函数都在 Swift 里注册了，反过来也是；模块名与事件名两边同一个", () => {
    const swift = read(`${MOBILE}/ios/OttoSpeechModule.swift`);
    const js = read(`${MOBILE}/index.ts`);
    const native = [...swift.matchAll(/AsyncFunction\("(\w+)"\)/g)].map((m) => m[1]!).sort();
    const declared = [...js.matchAll(/^\s+(\w+)\([^)]*\): Promise<void>;/gm)].map((m) => m[1]!).sort();
    expect(native).toEqual(["pause", "play", "resume", "start", "status", "stop", "stopPlay"]);
    expect(declared).toEqual(native);
    expect(swift).toContain('Name("OttoSpeech")');
    expect(swift).toContain('Events("onSpeech")');
    expect(swift).toContain('sendEvent("onSpeech"');
    expect(js).toContain('requireOptionalNativeModule<OttoSpeechModule>("OttoSpeech")');
    expect(js).toContain("onSpeech:");
  });

  it("expo-module.config.json 指到 OttoSpeechModule；app.json 带麦克风与语音识别两句授权说明", () => {
    const cfg = JSON.parse(read(`${MOBILE}/expo-module.config.json`)) as { platforms?: string[]; apple?: { modules?: string[] } };
    expect(cfg.platforms).toEqual(["apple"]);
    expect(cfg.apple?.modules).toEqual(["OttoSpeechModule"]);
    expect(read(`${MOBILE}/ios/OttoSpeechModule.swift`)).toContain("public class OttoSpeechModule: Module");
    const app = JSON.parse(read("mobile/app.json")) as { expo: { ios?: { infoPlist?: Record<string, string> } } };
    const plist = app.expo.ios?.infoPlist ?? {};
    expect(plist.NSMicrophoneUsageDescription ?? "").not.toBe("");
    expect(plist.NSSpeechRecognitionUsageDescription ?? "").not.toBe("");
  });
});
