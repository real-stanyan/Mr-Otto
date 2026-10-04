// 热更新在手机这一侧（#1463，ADR-0340）：判据全在 src/shared/launchUpdate.ts，这里只把它接到 expo-updates 上。
//
// · 冷启动：useLaunchUpdate() 回「开屏要不要接着挡」——还在查最多挡 CHECK_CAP_MS，知道有更新就挡到下完，下完当场
//   reloadAsync 进新包。人打开一次就在新包上，不用退出两次（Mandy App 同款，见那边的 ADR 0003）。
// · 从后台回来：在后台待够 30 分钟、没在打电话、不在冷却期，就查一次、有就下、下完重启（canRestartOnResume）。
// · 开发构建 / Expo Go 里 expo-updates 不工作（reloadAsync 会拒），整套旁路。
import AsyncStorage from "expo-sqlite/kv-store";
import * as Updates from "expo-updates";
import { useEffect, useReducer, useRef, useState } from "react";
import { AppState } from "react-native";
import {
  CHECK_CAP_MS, INITIAL_LAUNCH_UPDATE_LOCAL, canRestartOnResume, launchUpdateHold, launchUpdatePhase, updateKey,
  type LaunchUpdateLocal,
} from "../../../src/shared/launchUpdate.js";
import { inSystemCall } from "../call/systemCall.js";
import { voiceListening } from "../voice/voiceStore.js";

const ENABLED = Updates.isEnabled && !__DEV__;
const LAST_APPLIED_KEY = "otto.updates.launchAppliedTo";
const LAST_RELOAD_KEY = "otto.updates.lastReloadAt";
/** 重启那一下画什么：与原生启动画面同一个底色（白），读起来像开屏眨了一下，不像崩了 */
const RELOAD_SCREEN = { backgroundColor: "#ffffff", spinner: { enabled: false }, fade: true } as const;

async function restart(key: string | null): Promise<boolean> {
  // 重启之前写：重启之后这段代码就没了，下次启动靠它分辨「重启没成功」与「新来的一个」
  if (key !== null) await AsyncStorage.setItem(LAST_APPLIED_KEY, key).catch(() => undefined);
  await AsyncStorage.setItem(LAST_RELOAD_KEY, String(Date.now())).catch(() => undefined);
  try {
    await Updates.reloadAsync({ reloadScreenOptions: RELOAD_SCREEN });
    return true;
  } catch {
    return false;
  }
}

/** 开屏要不要接着挡（true = 挡）。elapsedMs = 开屏已经挡了多久（从开屏自己的进度条走完算起） */
export function useLaunchUpdate(): (overMs: number) => boolean {
  const updates = Updates.useUpdates();
  const [lastApplied, setLastApplied] = useState<string | null | undefined>(ENABLED ? undefined : null);
  const [local, step] = useReducer((s: LaunchUpdateLocal): LaunchUpdateLocal => ({ attemptsLeft: Math.max(0, s.attemptsLeft - 1) }), INITIAL_LAUNCH_UPDATE_LOCAL);
  const [gaveUp, setGaveUp] = useState(false);
  const fetching = useRef(false);

  useEffect(() => {
    if (!ENABLED) return;
    let alive = true;
    AsyncStorage.getItem(LAST_APPLIED_KEY).then(
      (v) => alive && setLastApplied(v),
      () => alive && setLastApplied(null),
    );
    return () => {
      alive = false;
    };
  }, []);

  const phase = gaveUp ? ({ kind: "off" } as const) : launchUpdatePhase({ updates, enabled: ENABLED, lastApplied, local });

  const fetchIn = phase.kind === "fetch" ? phase.inMs : null;
  useEffect(() => {
    if (fetchIn === null || fetching.current) return;
    const t = setTimeout(() => {
      fetching.current = true;
      step();
      Updates.fetchUpdateAsync()
        .catch(() => undefined)
        .finally(() => {
          fetching.current = false;
        });
    }, fetchIn);
    return () => clearTimeout(t);
  }, [fetchIn]);

  const downloaded = updates.downloadedUpdate;
  useEffect(() => {
    if (phase.kind !== "ready") return;
    void restart(downloaded ? updateKey(downloaded) : null).then((ok) => {
      // 重启不了（原生出了岔子）：照常打开，更新下次冷启动照样跑
      if (!ok) setGaveUp(true);
    });
  }, [phase.kind, downloaded?.updateId]);

  const hold = launchUpdateHold(phase);
  return (overMs) => hold === "uncapped" || (hold === "capped" && overMs < CHECK_CAP_MS);
}

// ── 从后台回来 ──────────────────────────────────────────────────────

let backgroundedAt: number | null = null;
let checking = false;

async function onResume(): Promise<void> {
  const now = Date.now();
  const away = backgroundedAt === null ? null : now - backgroundedAt;
  backgroundedAt = null;
  const lastRaw = await AsyncStorage.getItem(LAST_RELOAD_KEY).catch(() => null);
  const lastReloadAt = lastRaw !== null && /^\d+$/.test(lastRaw) ? Number(lastRaw) : null;
  const inCall = (): boolean => inSystemCall() || voiceListening();
  const verdict = (): boolean => canRestartOnResume({ enabled: ENABLED, backgroundedMs: away, inCall: inCall(), lastReloadAt, now: Date.now() }).ok;
  if (!verdict() || checking) return;
  checking = true;
  try {
    const r = await Updates.checkForUpdateAsync();
    if (!r.isAvailable) return;
    const f = await Updates.fetchUpdateAsync();
    // 下载那几秒里人可能接起了电话：重启之前再判一次
    if (!f.isNew || !verdict()) return;
    await restart(f.manifest && "id" in f.manifest && typeof f.manifest.id === "string" ? f.manifest.id : null);
  } catch {
    // 查不到 / 下不下来：下次再说
  } finally {
    checking = false;
  }
}

if (ENABLED) {
  AppState.addEventListener("change", (s) => {
    if (s === "background") backgroundedAt = Date.now();
    else if (s === "active") void onResume();
  });
}
