// 「应用」页里的 Apple 健康（#1671，demo 方向 B）：那一行在三种状态下怎么画、目录搜得到它、能读的类别一类不漏。
import { describe, expect, it } from "vitest";
import { HEALTH_METRICS } from "../../src/shared/health.js";
import {
  HEALTH_CATALOG_CATEGORY, HEALTH_METRIC_NAMES, healthAppRow, healthCatalogMatches, showPhoneAppsEmpty,
} from "../../src/shared/mobileHealthApp.js";
import { PHONE_APPS_FOOTER } from "../../src/shared/mobileConnectors.js";

describe("healthAppRow", () => {
  it("没连：说能干什么，右边给「连接」", () => {
    expect(healthAppRow("off")).toEqual({ detail: "让智能体读你的步数、睡眠、心率…", action: "connect", connected: false });
  });
  it("连上：说已连接，点进详情", () => {
    expect(healthAppRow("on")).toEqual({ detail: "已连接 · 只在 Otto 开着时读", action: "detail", connected: true });
  });
  it("设备不支持：灰掉、不给动作，不藏", () => {
    expect(healthAppRow("unavailable")).toEqual({ detail: "这台设备读不了健康数据", action: null, connected: false });
  });
});

describe("healthCatalogMatches", () => {
  it.each(["", "  ", "健康", "apple", "Health", "APPLE 健康", "睡眠", "步数"])("搜「%s」能找到", (q) => {
    expect(healthCatalogMatches(q)).toBe(true);
  });
  it.each(["gmail", "notion", "日历"])("搜「%s」找不到", (q) => {
    expect(healthCatalogMatches(q)).toBe(false);
  });
  it("分类名", () => {
    expect(HEALTH_CATALOG_CATEGORY).toBe("这台手机");
  });
});

describe("类别名", () => {
  it("每个 metric 都有名字，顺序同 HEALTH_METRICS", () => {
    expect(Object.keys(HEALTH_METRIC_NAMES)).toEqual([...HEALTH_METRICS]);
  });
});

describe("「手机上接的」", () => {
  it("组尾两头都说清（云端应用手机关机也能用；健康要 Otto 开着）", () => {
    expect(PHONE_APPS_FOOTER).toBe("接好的应用凭据存在云端，手机关机也能用；Apple 健康只在 Otto 开着时读这台手机。");
  });
  it("空态只在健康不可用、又一个都没接时出现", () => {
    expect(showPhoneAppsEmpty({ healthAvailable: true, cloudApps: 0 })).toBe(false);
    expect(showPhoneAppsEmpty({ healthAvailable: false, cloudApps: 0 })).toBe(true);
    expect(showPhoneAppsEmpty({ healthAvailable: false, cloudApps: 2 })).toBe(false);
  });
});
