// Apple 健康开关（#1656，spec §2.1）：默认关，存在这台手机的 kv-store（同外观偏好——属于这台手机，不跟账号走）。
// 打开 = 先弹 iOS 的 HealthKit 授权页，再向云端声明「这台能读健康」（cloudClient 订阅这里的变化重发 caps）。
// iOS 不告诉 App 哪几类被拒了：授权页点了「不允许」开关照样是开的，只是读出来是空——设置页的说明写清去哪改。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import type { HealthQuery } from "../../../src/shared/health.js";
import { OttoHealth } from "../../modules/otto-health/index.js";
import { createStore } from "../externalStore.js";

const KEY = "otto.health";
const store = createStore<{ on: boolean }>({ on: false });
const listeners = new Set<() => void>();

export function healthAvailable(): boolean {
  return OttoHealth !== null && OttoHealth.isAvailable();
}

export function healthEnabled(): boolean {
  return store.get().on && healthAvailable();
}

export function useHealthEnabled(): boolean {
  return useSyncExternalStore(store.subscribe, () => store.get().on);
}

/** 开关变了（cloudClient 用它重发 caps）。不回退订：订阅方是模块顶层，活到进程结束 */
export function onHealthPrefChange(cb: () => void): void {
  listeners.add(cb);
}

function apply(on: boolean): void {
  store.set({ on });
  for (const cb of listeners) cb();
}

/** 冷启动读一次（App.tsx 顶层调）；读不到 = 关 */
export async function loadHealthPref(): Promise<void> {
  let raw: string | null = null;
  try {
    raw = await AsyncStorage.getItem(KEY);
  } catch {
    // 读不到 = 关
  }
  apply(raw === "1");
}

/** 打开时先请求授权：抛错 = 没打开（调用方把 message 画出来） */
export async function setHealthEnabled(on: boolean): Promise<void> {
  if (on) {
    if (!healthAvailable()) throw new Error("这台设备读不了健康数据");
    // healthAvailable() 为真时 OttoHealth 必非空；这一行只为让 TS 收窄（不用 `!`）
    if (OttoHealth === null) return;
    await OttoHealth.requestAuthorization();
  }
  apply(on);
  try {
    if (on) await AsyncStorage.setItem(KEY, "1");
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // 存不下：这一次照样生效，下次冷启动回到关
  }
}

export function readHealth(q: HealthQuery): Promise<unknown> {
  if (OttoHealth === null) return Promise.reject(new Error("这个版本的 App 没有健康模块"));
  return OttoHealth.query(q.metrics, q.from, q.to);
}
