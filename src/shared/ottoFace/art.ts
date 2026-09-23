// ottoFace/art —— 画好的几层 + 缓存（#1356）。给不走 canvas 的那一侧（手机端 react-native-svg）用。
//
// 同一个 (坑位, 状态, motion) 画出来的帧逐格相同（`frame.ts` 有断言），所以按这个键记住
// 算好的 SVG 串：会动的脸每拍只算一次 motion，键没变就连 composeFrame 都不跑。
// 缓存是按最久没用的先扔（LRU）：一墙十几张脸、每张一个态，常驻的键不过几十个。

import { fnv1a } from "../fnv1a.js";
import { composeFrameAt, frameMotion, motionKey, type FrameOptions } from "./frame.js";
import { faceLayers, faceRim, runsPath } from "./runs.js";
import { GRID_H, GRID_W } from "./sprites.js";
import type { FaceState } from "./states.js";

export interface FaceArtLayer {
  readonly tone: string;
  readonly color: string;
  readonly d: string;
}

export interface FaceArt {
  readonly key: string;
  readonly layers: readonly FaceArtLayer[];
  /** 轮廓外一圈的 d 串（深色底上画成浅色） */
  readonly rim: string;
  /** 角标颜色；null = 不画 */
  readonly badge: string | null;
  /** 整张脸压淡（离线那一档） */
  readonly dim: boolean;
}

export function faceArtKey(slot: number, state: FaceState, t: number, opts?: FrameOptions): string {
  return `${slot}|${state}|${motionKey(frameMotion(state, t, opts))}`;
}

export function createFaceArtCache(
  limit = 256
): (slot: number, state: FaceState, t: number, opts?: FrameOptions) => FaceArt {
  const cache = new Map<string, FaceArt>();
  return (slot, state, t, opts) => {
    const m = frameMotion(state, t, opts);
    const key = `${slot}|${state}|${motionKey(m)}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key);
      cache.set(key, hit); // 挪到最新
      return hit;
    }
    const frame = composeFrameAt(slot, state, m);
    const art: FaceArt = {
      key,
      layers: faceLayers(frame).map((l) => ({ tone: l.tone, color: l.color, d: runsPath(l.runs) })),
      rim: runsPath(faceRim(frame)),
      badge: frame.badge,
      dim: frame.dim,
    };
    cache.set(key, art);
    if (cache.size > limit) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return art;
  };
}

/** 三档：每格 0.5 / 1 / 2 点。**盒子就是脸的真实尺寸**（网格乘档位），不裁、不加圆底（spec §3.1） */
export const FACE_TIERS = { s: 0.5, m: 1, l: 2 } as const;
export type FaceTier = keyof typeof FACE_TIERS;

export function faceBox(tier: FaceTier): { w: number; h: number } {
  const k = FACE_TIERS[tier];
  return { w: GRID_W * k, h: GRID_H * k };
}

/** 一墙脸各自错开的相位（毫秒）：共用同一个时刻的话一墙脸同时眨眼。按 id 派生，同一只每次
    打开都在同一个相位上——不用随机数，理由同 frame.ts 的眨眼 */
export function facePhase(id: string): number {
  return fnv1a(id) % 12_000;
}
