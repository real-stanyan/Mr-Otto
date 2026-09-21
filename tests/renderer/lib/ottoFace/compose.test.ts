// 合成器。这些断言全是「改一个数字就静默复发」的那类——第一版里角标真的越界过
// （坐标加了两次偏移量，泡跑到网格外三列被裁掉），而那种错不会抛异常。

import { describe, expect, it } from "vitest";
import { BADGE_SIZE, composeFrame, layoutFor, RIM, scaleForHeight } from "@/lib/ottoFace/compose.js";
import { FACE_STATE_LIST } from "@/lib/ottoFace/states.js";
import { FACE_CHARACTERS } from "@/lib/ottoFace/characters/index.js";
import { OTTO } from "@/lib/ottoFace/characters/otto.js";

const L = layoutFor(OTTO);

function cellAt(rows: readonly string[], x: number, y: number): string {
  return rows[y]?.[x] ?? ".";
}


/** 扫出第一格「贴着网格边界的角色像素」。断言写成「先扫后判」而不是每格一次 expect：
 *  八个角色 × 四个状态 × 十九个时刻 × 三千格 × 八邻域，每格一次 expect 要跑一分半 */
function firstNakedEdge(f: { w: number; h: number; rows: readonly string[] }): string | null {
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const c = cellAt(f.rows, x, y);
      if (c === "." || c === RIM || c === "A") continue;
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= f.w || ny < 0 || ny >= f.h) return `(${x},${y}) 贴边`;
        if (cellAt(f.rows, nx, ny) === ".") return `(${nx},${ny}) 该被描上`;
      }
    }
  }
  return null;
}

function firstStrayInBadgeSlot(f: { h: number; rows: readonly string[] }, badgeX: number): string | null {
  for (let y = 0; y < f.h; y++) {
    for (let x = badgeX; x < badgeX + BADGE_SIZE; x++) {
      const c = cellAt(f.rows, x, y);
      if (c !== "." && c !== "A") return `(${x},${y}) = ${c}`;
    }
  }
  return null;
}

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] as const;

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
        expect(firstStrayInBadgeSlot(composeFrame(OTTO, s, t), L.badgeX), `${s}@${t}`).toBeNull();
      }
    }
  });

  it("角标一格也不越出右边界", () => {
    expect(L.badgeX + BADGE_SIZE).toBeLessThanOrEqual(L.gridW);
  });

  it("摆到极限、浮到极限，四周都还留得下描边那一格", () => {
    // 原来这条只断言「最左一列是空的」，靠的是 PAD_L=1 恰好卡死。加描边之后留白变了，
    // 那种写法会变成一句空话。这里改成断言真正的不变量：**每一格角色像素的八邻域
    // 都还在网格里，而且要么是角色要么是描边** —— 有一格贴到边界就说明被裁了，
    // 而被裁是静默的（put() 直接丢掉越界的格子，不抛）
    for (const ch of FACE_CHARACTERS) {
      for (const s of ["idle", "waiting", "thinking", "sleep"] as const) {
        for (let t = 0; t < 3000; t += 163) {
          const f = composeFrame(ch, s, t, { rim: "#FFFFFF", pointerX: 1, pointerY: 1 });
          expect(firstNakedEdge(f), `${ch.id}/${s}@${t}`).toBeNull();
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

describe("描边", () => {
  it("不给就一格也不画", () => {
    const f = composeFrame(OTTO, "idle", 0);
    expect(f.rows.join("")).not.toContain(RIM);
    expect(f.palette[RIM]).toBeUndefined();
  });

  it("给了就有，颜色按给的来", () => {
    const f = composeFrame(OTTO, "idle", 0, { rim: "#FFFFFF" });
    expect(f.rows.join("")).toContain(RIM);
    expect(f.palette[RIM]).toBe("#FFFFFF");
  });

  it("frozen 时描边跟着降饱和，不会剩一圈雪白", () => {
    // 冻住的那一格本来就该最不抢眼。描边不跟着降的话，一墙头像里最亮的反而是它
    const f = composeFrame(OTTO, "frozen", 0, { rim: "#FFFFFF" });
    expect(f.palette[RIM]).not.toBe("#FFFFFF");
  });

  it("描边一格也进不了角标槽", () => {
    // 角色摆到最右时描边会再外扩一格，间隙留 1 格的话正好压在角标第一列上
    for (const ch of FACE_CHARACTERS) {
      const L = layoutFor(ch);
      for (const s of FACE_STATE_LIST) {
        for (let t = 0; t < 2000; t += 311) {
          const f = composeFrame(ch, s, t, { rim: "#FFFFFF" });
          expect(firstStrayInBadgeSlot(f, L.badgeX), `${ch.id}/${s}@${t}`).toBeNull();
        }
      }
    }
  });

  it("没有角色占用 R / A 这两个字母", () => {
    // 占了的话描边或角标会把脸上的某一色整片顶掉，而那是一大片纯色，改完第一眼看不出
    for (const ch of FACE_CHARACTERS) {
      expect(Object.keys(ch.palette)).not.toContain(RIM);
      expect(Object.keys(ch.palette)).not.toContain("A");
    }
  });
});
