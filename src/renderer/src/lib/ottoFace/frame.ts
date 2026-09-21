// ottoFace/frame —— 把画料叠成一帧（#1345，ADR-0311）。
//
// **纯函数**：给定坑位 / 状态 / 时刻，画出来的东西完全确定。所以「静态一帧」和「动画」
// 走的是同一段代码 —— 不会出现「不动的那版长得不一样」，也不用为名册那一墙脸另写
// 一条渲染路径。canvas 那一层（`paint.ts`）只把网格坐标换成像素，一个判断都不做，
// 于是这个文件进得了 vitest 而 jsdom 没有 canvas 这件事碍不着它。

import {
  BEARD_CHEEK_CELLS,
  BROWS,
  BROW_Y,
  EYES,
  EYE_LX,
  EYE_RX,
  EYE_Y,
  FACE_CHARACTERS,
  HEAD,
  MOUTHS,
  MOUTH_X,
  MOUTH_Y,
  TAIL_CELLS,
} from "./sprites.js";
import { BADGE_COLORS, FACE_STATES, type FaceState, type Timed } from "./states.js";

/** 一格。`x`/`y` 是网格坐标（已经把位移算进去了），`key` 是调色板的键 */
export interface FaceCell {
  x: number;
  y: number;
  key: string;
}

export interface FaceFrame {
  cells: readonly FaceCell[];
  /** 右下角那枚角标的颜色；`null` = 不画（`plain` 那一档） */
  badge: string | null;
  /** 整张脸压淡 */
  dim: boolean;
}

function resolve<T>(v: Timed<T>, t: number): T {
  return typeof v === "function" ? (v as (t: number) => T)(t) : v;
}

/** 坑位取模：越界 / 负数都落回 0..12。调用方给的坑位已经过了 `agentAvatar.ts` 那道闸
    （越界退回派生、不取模），这里的取模只是最后一道兜底，免得一个坏数字画成空白 */
export function faceCharacterAt(slot: number): number {
  const n = FACE_CHARACTERS.length;
  return ((Math.trunc(slot) % n) + n) % n;
}

/**
 * 一帧。`t` 是毫秒时刻（`performance.now()`），静态帧传 0。
 *
 * 叠的顺序就是盖住的顺序：光头 → 头发 / 配件 → 眉眼嘴 → 眼镜。眼镜最后，因为它
 * 套在眼睛外面。
 */
export function composeFrame(slot: number, state: FaceState, t: number): FaceFrame {
  const ch = FACE_CHARACTERS[faceCharacterAt(slot)]!;
  const st = FACE_STATES[state];
  const [dx, dy] = st.move !== null ? st.move(t) : ([0, 0] as const);

  const cells: FaceCell[] = [];
  const put = (x: number, y: number, key: string): void => {
    if (key === "" || key === ".") return;
    cells.push({ x: x + dx, y: y + dy, key });
  };
  const layer = (rows: readonly string[] | undefined): void => {
    if (rows === undefined) return;
    rows.forEach((row, y) => [...row].forEach((key, x) => put(x, y, key)));
  };

  layer(HEAD);
  layer(ch.top);
  if (ch.side !== undefined) {
    for (const [row, pair] of Object.entries(ch.side)) {
      const y = Number(row);
      const left = pair[0] ?? ".";
      const right = pair[1] ?? ".";
      if (left !== ".") {
        put(3, y, left);
        put(4, y, left);
      }
      if (right !== ".") {
        put(15, y, right);
        put(16, y, right);
      }
    }
  }
  if (ch.nub !== undefined) put(ch.nub[0], ch.nub[1], "D");
  if (ch.tail === true) for (const [x, y] of TAIL_CELLS) put(x, y, "D");
  if (ch.beard === true) {
    for (const [x, y] of BEARD_CHEEK_CELLS) put(x, y, "L");
    for (let x = 6; x < 14; x++) put(x, 12, "L"); // 下巴那一把
    for (let x = 7; x < 12; x++) put(x, 9, "L"); // 上唇那一撇
  }
  if (ch.stubble === true) for (let x = 5; x < 15; x++) if ((x + 1) % 2 !== 0) put(x, 12, "L");

  const brow = BROWS[resolve(st.brow, t)] ?? [];
  const eye = EYES[resolve(st.eye, t)] ?? [];
  const mouth = MOUTHS[resolve(st.mouth, t)] ?? [];
  // 右眉是左眉的镜像：皱眉那一档两条眉毛得对着往里压，各画各的会变成同向的斜杠
  for (const [x, y] of brow) {
    put(EYE_LX + x, BROW_Y + y, "I");
    put(EYE_RX + 1 - x, BROW_Y + y, "I");
  }
  for (const [x, y] of eye) {
    put(EYE_LX + x, EYE_Y + y, "I");
    put(EYE_RX + x, EYE_Y + y, "I");
  }
  for (const [x, y] of mouth) put(MOUTH_X + x, MOUTH_Y + y, "I");

  if (ch.specs === true) {
    // 眼镜画成**每只眼睛底下一道横杠 + 外侧一根镜腿 + 中间一点鼻梁**，不画整圈方框。
    //
    // 原型画的是完整的 4×4 方框，而眼睛本身就是 2×2、正好占满框的内腔 —— 画出来
    // 是一坨实心黑，读作墨镜/眼罩而不是眼镜；把上下两道留着也不行，两侧的杠会在
    // 鼻梁处连起来横贯整张脸，成了一条蒙眼带。这个分辨率上装不下「边框 + 里面还
    // 看得见眼睛」，所以只留镜框下沿这个最容易认的特征。
    //
    // 顺带守住了那条硬法理：**会动的只有眉眼嘴**。方框会把眯眼 / 闭眼 / 左右看 /
    // 叉叉全盖掉，那两只戴眼镜的水獭就再也没有表情了。
    const lens = (x0: number, temple: number): void => {
      for (let i = 0; i < 4; i++) put(x0 + i, 8, "I"); // 镜框下沿
      put(temple, 6, "I"); // 镜腿
      put(temple, 7, "I");
    };
    lens(5, 4);
    lens(10, 14);
    put(9, 6, "I"); // 鼻梁
  }

  return { cells, badge: st.badge === null ? null : BADGE_COLORS[st.badge], dim: st.dim };
}
