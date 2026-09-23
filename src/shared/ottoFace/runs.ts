// ottoFace/runs —— 一帧 → 画得出来的几层（#1356）。给**不走 canvas** 的那一侧用：
// 手机端的 react-native-svg 一种颜色一条 Path，而一条 Path 就是一串横向行程。
//
// 纯函数、零 IO：行程拼回去必须逐格等于原帧（有断言），SVG 那一侧因此一个判断都不做。

import type { FaceFrame } from "./frame.js";
import { GRID_H, GRID_W } from "./sprites.js";

/** 一段横向行程：从 (x, y) 起、向右 n 格 */
export type FaceRun = readonly [x: number, y: number, n: number];

export interface FaceLayer {
  /** 调色板的键（`#` / `o` / …） */
  readonly tone: string;
  readonly color: string;
  readonly runs: readonly FaceRun[];
}

/**
 * 一帧 → 每种颜色一层。层按色调键排序（稳定，与格子遍历顺序无关）；同一行里同色且相邻的
 * 格子合成一段。一格只有一种颜色，所以层与层之间不会重叠，谁先画都一样。
 * 色板里查不到的色调不画——与 `paint.ts` 同一条：透明而不是崩。
 */
export function faceLayers(frame: FaceFrame): FaceLayer[] {
  const byTone = new Map<string, Map<number, number[]>>();
  for (const c of frame.cells) {
    let rows = byTone.get(c.key);
    if (rows === undefined) {
      rows = new Map();
      byTone.set(c.key, rows);
    }
    const xs = rows.get(c.y);
    if (xs === undefined) rows.set(c.y, [c.x]);
    else xs.push(c.x);
  }
  const out: FaceLayer[] = [];
  for (const tone of [...byTone.keys()].sort()) {
    const color = frame.palette[tone];
    const rows = byTone.get(tone);
    if (color === undefined || rows === undefined) continue;
    out.push({ tone, color, runs: rowsToRuns(rows) });
  }
  return out;
}

/** 行程 → SVG path 的 d 串。一段一个闭合矩形：`M x y h n v 1 h -n z` */
export function runsPath(runs: readonly FaceRun[]): string {
  let d = "";
  for (const [x, y, n] of runs) d += `M${x} ${y}h${n}v1h-${n}z`;
  return d;
}

/**
 * 轮廓外一圈：自己空着、四邻里至少一格有颜色的格子（限在网格内）。
 * 深色底上把它画成浅色——这批脸的头发是纯黑的，贴在 #000 上整颗头会糊成一团；桌面靠圆盘
 * 解决这件事，手机不画圆盘（demo「不许裁」），所以靠描边。网格四周各留了 2 格
 * （`FACE_PAD`），呼吸 / 摆动最多挪 1 格，描边永远画得下。
 */
export function faceRim(frame: FaceFrame): FaceRun[] {
  const filled = new Set<number>();
  for (const c of frame.cells) filled.add(c.y * GRID_W + c.x);
  const at = (x: number, y: number): boolean => filled.has(y * GRID_W + x);
  const rim = new Map<number, number[]>();
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (at(x, y)) continue;
      const near =
        (x > 0 && at(x - 1, y)) ||
        (x < GRID_W - 1 && at(x + 1, y)) ||
        (y > 0 && at(x, y - 1)) ||
        (y < GRID_H - 1 && at(x, y + 1));
      if (!near) continue;
      const xs = rim.get(y);
      if (xs === undefined) rim.set(y, [x]);
      else xs.push(x);
    }
  }
  return rowsToRuns(rim);
}

function rowsToRuns(rows: ReadonlyMap<number, readonly number[]>): FaceRun[] {
  const runs: FaceRun[] = [];
  for (const y of [...rows.keys()].sort((a, b) => a - b)) {
    const xs = [...(rows.get(y) ?? [])].sort((a, b) => a - b);
    if (xs.length === 0) continue;
    let start = xs[0]!;
    let prev = start;
    for (let i = 1; i < xs.length; i++) {
      const x = xs[i]!;
      if (x === prev + 1) {
        prev = x;
        continue;
      }
      runs.push([start, y, prev - start + 1]);
      start = x;
      prev = x;
    }
    runs.push([start, y, prev - start + 1]);
  }
  return runs;
}
