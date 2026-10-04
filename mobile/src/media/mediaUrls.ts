// 图片 / 视频的签名地址（#1443 P1；#1491 P3 起 bucket 当参数）：两个 bucket 都是私有的，读要签名。
// · 同一帧里要的几张攒成一次 createSignedUrls（一页九宫格是一趟网络，不是九趟），按 bucket 各一趟。
// · 签一次用一小时，剩不到 5 分钟时重签。**同一个对象一直拿同一个地址**：RN 的 Image 按 URL 缓存，
//   每次渲染重签一次就是每次重新下载。
// · 签不出来（没权限 / 对象不在）记成 failed，气泡画「图片加载不出来」，不反复重试——人点一下会再试一次（retry）。
// · 缓存按「bucket + 路径」分键：dm-media 与 chat-media 的路径段数一样，光看路径分不出来。
import { useSyncExternalStore } from "react";
import { DM_MEDIA_BUCKET } from "../../../src/shared/chatMedia.js";
import { signMedia } from "../friends/friendsApi.js";

const TTL_SEC = 3600;
const REFRESH_MS = 5 * 60_000;
const SEP = "\u0000";

type Entry = { kind: "ok"; url: string; exp: number } | { kind: "pending" } | { kind: "failed" };

const cache = new Map<string, Entry>();
const listeners = new Set<() => void>();
let queue = new Set<string>();
/** 已经在签、还没回来的（过期前重签那几分钟里，别每次渲染都再发一趟） */
const inflight = new Set<string>();
let scheduled = false;
let version = 0;

const keyOf = (bucket: string, path: string): string => bucket + SEP + path;
const splitKey = (key: string): { bucket: string; path: string } => {
  const i = key.indexOf(SEP);
  return { bucket: key.slice(0, i), path: key.slice(i + 1) };
};

function emit(): void {
  version += 1;
  for (const l of listeners) l();
}

function flush(): void {
  scheduled = false;
  const keys = [...queue];
  queue = new Set();
  if (keys.length === 0) return;
  const byBucket = new Map<string, string[]>();
  for (const k of keys) {
    inflight.add(k);
    const { bucket, path } = splitKey(k);
    const list = byBucket.get(bucket);
    if (list === undefined) byBucket.set(bucket, [path]);
    else list.push(path);
  }
  let pending = byBucket.size;
  for (const [bucket, paths] of byBucket) {
    signMedia(bucket, paths, TTL_SEC)
      .then((got) => {
        const exp = Date.now() + TTL_SEC * 1000;
        for (const p of paths) {
          const url = got.get(p);
          cache.set(keyOf(bucket, p), url !== undefined ? { kind: "ok", url, exp } : { kind: "failed" });
        }
      })
      .catch(() => {
        for (const p of paths) cache.set(keyOf(bucket, p), { kind: "failed" });
      })
      .finally(() => {
        for (const p of paths) inflight.delete(keyOf(bucket, p));
        pending -= 1;
        if (pending === 0) emit();
      });
  }
}

function schedule(key: string, markPending: boolean): void {
  queue.add(key);
  if (markPending) cache.set(key, { kind: "pending" });
  if (!scheduled) {
    scheduled = true;
    setTimeout(flush, 0);
  }
}

/** 签失败的那一个再试一次（人点了「重试」） */
export function retryMediaUrl(path: string, bucket: string = DM_MEDIA_BUCKET): void {
  schedule(keyOf(bucket, path), true);
  emit();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** 组件里用：path 缺席回 null。签名在渲染之外发起（setTimeout），不在渲染里改状态 */
export function useMediaUrl(path: string | undefined, bucket: string = DM_MEDIA_BUCKET): string | null | "failed" {
  useSyncExternalStore(subscribe, () => version);
  return path === undefined ? null : peek(keyOf(bucket, path));
}

function peek(key: string): string | null | "failed" {
  const e = cache.get(key);
  if (e === undefined || (e.kind === "ok" && e.exp - Date.now() < REFRESH_MS)) {
    // 渲染里只记下来，真正的签名请求在下一拍发
    if (!queue.has(key) && !inflight.has(key)) schedule(key, e === undefined);
    return e?.kind === "ok" ? e.url : null;
  }
  return e.kind === "ok" ? e.url : e.kind === "pending" ? null : "failed";
}

/** 换号时清掉（ADR-0187：别把上一个账号的签名地址带给下一个） */
export function clearMediaUrls(): void {
  cache.clear();
  queue = new Set();
  emit();
}
