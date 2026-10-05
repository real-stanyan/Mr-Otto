// Apple 健康（#1656）手机端的接线。原生与 RN 进不了 vitest，这里读源码钉住安静出错的事：
// ① 权限文案与 entitlement 在 app.json 里（缺 entitlement 时 requestAuthorization 直接报错；缺文案 iOS 直接崩）；
// ② 只读：不出现写入权限文案、Swift 里 toShare 是空集；
// ③ 加了原生模块必须进位 runtimeVersion（publish-ota 据它判热更新能不能发）；
// ④ 模块名两端对得上。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const app = JSON.parse(read("mobile/app.json")) as { expo: { runtimeVersion: string; ios: { infoPlist: Record<string, unknown>; entitlements: Record<string, unknown> } } };

describe("app.json", () => {
  // 写入文案也得有（2026-10-05 build 10 实测）：只要带 HealthKit entitlement，App Store Connect 的导出校验就要求
  // NSHealthUpdateUsageDescription，缺了 `xcodebuild -exportArchive` 直接 EXPORT FAILED。只读不变——Swift 那边 toShare 仍是空集，
  // 文案照实说「不写入」
  it("HealthKit entitlement + 读取文案 + 照实说不写入的写入文案", () => {
    expect(app.expo.ios.entitlements["com.apple.developer.healthkit"]).toBe(true);
    expect(app.expo.ios.infoPlist.NSHealthShareUsageDescription).toBe("你问智能体健康相关的问题时，读取你的步数、睡眠、心率、体重和体能训练来回答。");
    expect(app.expo.ios.infoPlist.NSHealthUpdateUsageDescription).toBe("Otto 只读取健康数据，不会向「健康」写入任何内容。");
  });
  it("runtimeVersion 进位到 7（加了原生模块）", () => {
    expect(app.expo.runtimeVersion).toBe("7");
  });
});

describe("otto-health 模块", () => {
  const swift = read("mobile/modules/otto-health/ios/OttoHealthModule.swift");
  const reader = read("mobile/modules/otto-health/ios/HealthReader.swift");
  it("名字两端一致", () => {
    expect(swift).toMatch(/Name\("OttoHealth"\)/);
    expect(read("mobile/modules/otto-health/index.ts")).toMatch(/requireOptionalNativeModule<OttoHealthNative>\("OttoHealth"\)/);
    expect(read("mobile/modules/otto-health/expo-module.config.json")).toMatch(/"OttoHealthModule"/);
  });
  it("只读：toShare 为空", () => {
    expect(swift).toMatch(/requestAuthorization\(toShare: \[\], read: HealthReader\.readTypes\)/);
  });
  it("读的是 14 类里那些类型（每类一个标识）", () => {
    for (const id of ["stepCount", "distanceWalkingRunning", "activeEnergyBurned", "flightsClimbed", "appleExerciseTime", "appleStandHour",
      "sleepAnalysis", "heartRate", "restingHeartRate", "heartRateVariabilitySDNN", "oxygenSaturation", "bodyMass", "bodyFatPercentage", "workoutType"]) {
      expect(reader).toContain(id);
    }
  });
});

describe("手机 JS 接线", () => {
  const prefs = read("mobile/src/health/healthPrefs.ts");
  const client = read("mobile/src/cloud/cloudClient.ts");
  const settings = read("mobile/src/account/SettingsScreen.tsx");
  it("开关存在这台手机的 kv-store、默认关", () => {
    expect(prefs).toMatch(/import AsyncStorage from "expo-sqlite\/kv-store";/);
    expect(prefs).toMatch(/const KEY = "otto\.health";/);
    expect(prefs).toMatch(/createStore<\{ on: boolean \}>\(\{ on: false \}\)/);
  });
  it("打开前先请求授权；不可用就不让开", () => {
    expect(prefs).toMatch(/await OttoHealth\.requestAuthorization\(\)/);
    expect(prefs).toMatch(/if \(!healthAvailable\(\)\) throw new Error/);
  });
  it("cloudClient：声明能力、应答走 answerHealthQuery、开关变了重发 caps", () => {
    expect(client).toMatch(/deviceCaps: \(\) => \(\{ health: healthEnabled\(\) \}\),/);
    expect(client).toMatch(/onHealthQuery: \(q\) => answerHealthQuery\(q, \{ enabled: healthEnabled, read: readHealth \}\),/);
    expect(client).toMatch(/onHealthPrefChange\(\(\) => cloudClient\.refreshCaps\(\)\);/);
  });
  it("设置页有 Apple 健康这一组", () => {
    expect(settings).toMatch(/header="Apple 健康"/);
    expect(settings).toMatch(/setHealthEnabled\(/);
  });
  it("冷启动读开关", () => {
    expect(read("mobile/App.tsx")).toMatch(/void loadHealthPref\(\);/);
  });
});
