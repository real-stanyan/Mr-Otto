// 合成器。这些断言全是「改一个数字就静默复发」的那类——第一版里角标真的越界过
// （坐标加了两次偏移量，泡跑到网格外三列被裁掉），而那种错不会抛异常。

import { describe, expect, it } from "vitest";
import { BADGE_SIZE, composeFrame, layoutFor, PAD_L, scaleForHeight } from "@/lib/ottoFace/compose.js";
import { FACE_STATE_LIST } from "@/lib/ottoFace/states.js";
import { FACE_CHARACTERS } from "@/lib/ottoFace/characters/index.js";
import { OTTO } from "@/lib/ottoFace/characters/otto.js";

const L = layoutFor(OTTO);

function cellAt(rows: readonly string[], x: number, y: number): string {
  return rows[y]?.[x] ?? ".";
}

describe("composeFrame", () => {
  it("帧尺寸由角色算出，不是写死的常量", () => {
    const f = composeFrame(OTTO, "idle", 0);
    expect(f.w).toBe(L.gridW);
    expect(f.h).toBe(L.gridH);
    expect(f.rows).toHaveLength(L.gridH);
    for (const r of f.rows) expect(r).toHaveLength(L.gridW);
  });

  it("同一个 (角色, 状态, t) 永远是同一帧", () => {
    // 时间是入参不是 Date.now()——没有这条，下面每一条断言都是碰运气
    for (const s of FACE_STATE_LIST) {
      expect(composeFrame(OTTO, s, 7331).rows).toEqual(composeFrame(OTTO, s, 7331).rows);
    }
  });

  it("角标槽里只有角标，一格角色也漏不进去", () => {
    // 第一版的真实 bug：角标坐标加了两次偏移量，越界被裁 + 拖尾小泡压在头发上。
    // 现在槽整个在角色右侧之外，这条断言钉住那个布局前提
    for (const s of FACE_STATE_LIST) {
      for (let t = 0; t < 4000; t += 137) {
        const f = composeFrame(OTTO, s, t);
        for (let y = 0; y < f.h; y++) {
          for (let x = L.badgeX; x < L.badgeX + BADGE_SIZE; x++) {
            const c = cellAt(f.rows, x, y);
            expect(c === "." || c === "A", `${s}@${t} (${x},${y}) = ${c}`).toBe(true);
          }
        }
      }
    }
  });

  it("角标一格也不越出右边界", () => {
    expect(L.badgeX + BADGE_SIZE).toBeLessThanOrEqual(L.gridW);
  });

  it("角色画得下，左右摆动也不会被裁", () => {
    // waiting 会整体左右各摆一格；PAD_L 少一格就会在摆到左边时切掉一列
    expect(PAD_L).toBeGreaterThanOrEqual(1);
    for (const s of ["idle", "waiting", "thinking"] as const) {
      for (let t = 0; t < 3000; t += 83) {
        const f = composeFrame(OTTO, s, t);
        for (let y = 0; y < f.h; y++) {
          // 最左一列只可能是透明：角色本体从 PAD_L 起画，摆到最左也只占到第 0 列之后
          expect(cellAt(f.rows, 0, y) === "." || PAD_L > 1).toBe(true);
        }
      }
    }
  });

  it("换状态会换帧，不是画了同一张", () => {
    const a = composeFrame(OTTO, "idle", 500).rows.join("\n");
    const b = composeFrame(OTTO, "waiting", 500).rows.join("\n");
    const c = composeFrame(OTTO, "failed", 500).rows.join("\n");
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("frozen 整张脸降饱和，且不与常态共用色板对象", () => {
    const normal = composeFrame(OTTO, "idle", 0).palette;
    const frozen = composeFrame(OTTO, "frozen", 0).palette;
    expect(frozen["o"]).not.toBe(normal["o"]);
    expect(frozen["#"]).not.toBe(normal["#"]);
  });

  it("pointer 视线只被 look:'pointer' 的状态读", () => {
    const left = composeFrame(OTTO, "idle", 500, { pointerX: -1 }).rows.join("\n");
    const right = composeFrame(OTTO, "idle", 500, { pointerX: 1 }).rows.join("\n");
    expect(left).not.toBe(right);
    // weaving 的 look 是 still，给多少指针偏移都该一模一样
    const a = composeFrame(OTTO, "weaving", 500, { pointerX: -1 }).rows.join("\n");
    const b = composeFrame(OTTO, "weaving", 500, { pointerX: 1 }).rows.join("\n");
    expect(a).toBe(b);
  });

  it("指针偏移钳在 -1..1，给得再离谱也不会把眼睛甩出脸外", () => {
    const sane = composeFrame(OTTO, "idle", 500, { pointerX: 1 }).rows.join("\n");
    const absurd = composeFrame(OTTO, "idle", 500, { pointerX: 9999 }).rows.join("\n");
    expect(absurd).toBe(sane);
  });

  it("眨眼是周期的，不是随机的", () => {
    // 眨眼周期由两个互质的数叠出来：看着不规律，但可复现。用随机数的话
    // 上面所有「同一个 t 同一帧」的断言都会间歇性红
    const frames = new Set<string>();
    for (let t = 0; t < 8000; t += 10) frames.add(composeFrame(OTTO, "idle", t).rows.join(""));
    // 8 秒内至少眨过一次（帧形态不止一种）
    expect(frames.size).toBeGreaterThan(1);
  });
});

describe("scaleForHeight", () => {
  it("永远是正整数——取小数就是次像素插值，像素画当场糊掉", () => {
    for (const ch of FACE_CHARACTERS) {
      for (const px of [1, 13, 52, 112, 400]) {
        const s = scaleForHeight(ch, px);
        expect(Number.isInteger(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("同一个目标高度下，全体角色收敛到一个尺寸段里", () => {
    // 这条是这个函数存在的理由：Otto 原生 19×18，这批头像原生二十四五格，
    // 同一个 scale 摆一排 Otto 会小掉四成。断言最高最矮不超过 1.35 倍
    const hs = FACE_CHARACTERS.map((ch) => layoutFor(ch).gridH * scaleForHeight(ch, 120));
    expect(Math.max(...hs) / Math.min(...hs)).toBeLessThan(1.35);
  });
});
