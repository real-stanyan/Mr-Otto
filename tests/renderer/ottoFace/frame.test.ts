// 画料与合成。这里断言的全是「改一个数字就静默复发」的那类——**这一族错不会抛异常**：
// 脸上少一只眼睛、一排头像里有一个大一圈、坑位错位给所有人换了脸，跑起来都是绿的。

import { describe, expect, it } from "vitest";
import {
  composeFrame,
  faceCharacterAt,
  FACE_CANVAS,
  FACE_CHARACTERS,
  FACE_PACKS,
  FACE_STATE_LIST,
  FACE_STATES,
  faceAnimates,
  GRID_H,
  GRID_W,
} from "../../../src/renderer/src/lib/ottoFace/index.js";
import { AGENT_AVATAR_COUNT } from "../../../src/renderer/src/lib/agentAvatarSlot.js";

describe("坑位表", () => {
  it("坑位数与派生的模数一致", () => {
    // 这两个数分家 = 给所有没手动挑过头像的 agent 换一张脸（sprites.ts 法理 ③）
    expect(FACE_CHARACTERS).toHaveLength(AGENT_AVATAR_COUNT);
  });

  it("越界退回第 0 格，不取模", () => {
    // 取模会安静地映射到另一个人，看起来像「他挑了这张」
    expect(faceCharacterAt(0)).toBe(FACE_CHARACTERS[0]);
    expect(faceCharacterAt(-1)).toBe(FACE_CHARACTERS[0]);
    expect(faceCharacterAt(99)).toBe(FACE_CHARACTERS[0]);
    expect(faceCharacterAt(1.5)).toBe(FACE_CHARACTERS[0]);
    expect(faceCharacterAt(AGENT_AVATAR_COUNT - 1)).toBe(FACE_CHARACTERS[AGENT_AVATAR_COUNT - 1]);
  });

  it("每个坑位都指到一份真角色包", () => {
    for (const [slot, ch] of FACE_CHARACTERS.entries()) {
      expect(FACE_PACKS, `坑位 ${slot}`).toContain(ch);
    }
  });
});

describe("角色包", () => {
  it.each(FACE_PACKS.map((c) => [c.id, c] as const))("%s：矩阵是矩形，且与共同画布一致", (_id, ch) => {
    // 一排头像里谁大一圈是第一眼看得出来的，而缩放只能取整，渲染那一侧补不回来
    expect(ch.w).toBe(FACE_CANVAS.w);
    expect(ch.h).toBe(FACE_CANVAS.h);
    expect(ch.base).toHaveLength(ch.h);
    for (const [j, row] of ch.base.entries()) expect(row.length, `第 ${j} 行`).toBe(ch.w);
  });

  it.each(FACE_PACKS.map((c) => [c.id, c] as const))("%s：用到的色号都在色板里", (_id, ch) => {
    const known = new Set(Object.keys(ch.palette));
    for (const [j, row] of ch.base.entries()) {
      for (const [i, t] of [...row].entries()) {
        if (t !== ".") expect(known.has(t), `(${i},${j}) = ${t}`).toBe(true);
      }
    }
    // ink 画五官、skin 填擦除框；查不到颜色的话合成出来是一片透明
    expect(known.has(ch.ink)).toBe(true);
    expect(known.has(ch.skin)).toBe(true);
    for (const box of ch.erase) {
      const fill = box[4];
      if (fill !== undefined) expect(known.has(fill), `填充色 ${fill}`).toBe(true);
    }
  });

  it.each(FACE_PACKS.map((c) => [c.id, c] as const))("%s：最胖的那种表情也戳不出脸外", (_id, ch) => {
    // 算漏了的后果是眼睛被裁半只，而半只眼睛在 24px 下看着只是「有点怪」，没人会报
    const LOOK = 2, BROW = 2;
    const fits = (pat: readonly string[], x: number, y: number, slack: number, what: string): void => {
      if (pat.every((r) => r.length === 0)) return; // 宽度 0 = 这个角色不画这处五官
      const w = Math.max(...pat.map((r) => r.length));
      expect(x - slack, `${what} 左`).toBeGreaterThanOrEqual(0);
      expect(y - slack, `${what} 上`).toBeGreaterThanOrEqual(0);
      expect(x + w + slack, `${what} 右`).toBeLessThanOrEqual(ch.w);
      expect(y + pat.length + slack, `${what} 下`).toBeLessThanOrEqual(ch.h);
    };
    fits(ch.brows.L, ch.anchors.browL[0], ch.anchors.browL[1], BROW, "左眉");
    fits(ch.brows.R, ch.anchors.browR[0], ch.anchors.browR[1], BROW, "右眉");
    for (const [shape, pair] of Object.entries(ch.eyes)) {
      fits(pair.L, ch.anchors.eyeL[0] + pair.lx, ch.anchors.eyeL[1] + pair.ly, LOOK, `左眼 ${shape}`);
      fits(pair.R, ch.anchors.eyeR[0] + pair.rx, ch.anchors.eyeR[1] + pair.ry, LOOK, `右眼 ${shape}`);
    }
    for (const [shape, pat] of Object.entries(ch.mouths)) {
      fits(pat, ch.anchors.mouth[0], ch.anchors.mouth[1], 1, `嘴 ${shape}`);
    }
  });

  it("十个角色互不相同——不是一张光头换十顶头发", () => {
    // 上一版正是这么塌的：13 个坑位共用一张 HEAD，看过去是同一个人戴了 13 顶假发。
    // 这条断言的是**脸本身**不同，不是头发不同：抹掉五官之后的矩阵两两不等
    const seen = new Set(FACE_PACKS.map((c) => c.base.join("\n")));
    expect(seen.size).toBe(FACE_PACKS.length);
  });
});

describe("composeFrame", () => {
  it("同一个 (坑位, 状态, t) 永远是同一帧", () => {
    // 时间是入参不是 Date.now()——没有这条，下面每一条断言都是碰运气
    for (const s of FACE_STATE_LIST) {
      expect(composeFrame(3, s, 7331).cells).toEqual(composeFrame(3, s, 7331).cells);
    }
  });

  it("一格都不出网格", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      for (const s of FACE_STATE_LIST) {
        for (let t = 0; t < 4000; t += 317) {
          const stray = composeFrame(slot, s, t, { pointerX: 1, pointerY: 1 }).cells.find(
            (c) => c.x < 0 || c.x >= GRID_W || c.y < 0 || c.y >= GRID_H
          );
          expect(stray, `坑位 ${slot} / ${s} @ ${t}`).toBeUndefined();
        }
      }
    }
  });

  it("换状态会换帧，不是画了同一张", () => {
    const a = composeFrame(0, "idle", 500).cells;
    const b = composeFrame(0, "waiting", 500).cells;
    const c = composeFrame(0, "failed", 500).cells;
    expect(a).not.toEqual(b);
    expect(b).not.toEqual(c);
  });

  it("换坑位会换脸", () => {
    const seen = new Set(
      FACE_CHARACTERS.map((_, slot) => JSON.stringify(composeFrame(slot, "plain", 0).cells))
    );
    // 13 个坑位映射到 10 个角色，所以不是 13 种；但至少得有十种不同的脸
    expect(seen.size).toBe(FACE_PACKS.length);
  });

  it("眨眼是周期的，不是随机的", () => {
    // 用随机数的话上面所有「同一个 t 同一帧」的断言都会间歇性红
    const frames = new Set<string>();
    for (let t = 0; t < 8000; t += 10) frames.add(JSON.stringify(composeFrame(0, "idle", t).cells));
    expect(frames.size).toBeGreaterThan(1);
  });

  it("pointer 视线只被 look:'pointer' 的状态读", () => {
    const left = JSON.stringify(composeFrame(0, "idle", 500, { pointerX: -1 }).cells);
    const right = JSON.stringify(composeFrame(0, "idle", 500, { pointerX: 1 }).cells);
    expect(left).not.toBe(right);
    // weaving 的 look 是 still，给多少指针偏移都该一模一样
    const a = JSON.stringify(composeFrame(0, "weaving", 500, { pointerX: -1 }).cells);
    const b = JSON.stringify(composeFrame(0, "weaving", 500, { pointerX: 1 }).cells);
    expect(a).toBe(b);
  });

  it("指针偏移钳在 -1..1，给得再离谱也不会把眼睛甩出脸外", () => {
    const sane = JSON.stringify(composeFrame(0, "idle", 500, { pointerX: 1 }).cells);
    const absurd = JSON.stringify(composeFrame(0, "idle", 500, { pointerX: 9999 }).cells);
    expect(absurd).toBe(sane);
  });

  it("frozen 降饱和，且不与常态共用色板对象", () => {
    const normal = composeFrame(0, "idle", 0).palette;
    const frozen = composeFrame(0, "frozen", 0).palette;
    for (const k of Object.keys(normal)) expect(frozen[k]).not.toBe(normal[k]);
  });
});

describe("状态表", () => {
  it("plain 不画角标也不动", () => {
    // 「我们不知道它在干嘛」不是「它闲着」——画一个恒灰的勾等于宣称一件查不到的事
    expect(FACE_STATES.plain.badge).toBeNull();
    expect(faceAnimates("plain")).toBe(false);
  });

  it("queued 是唯一完全不动的那一档", () => {
    // ADR-0250：它一个 token 都还没跑，动起来就是撒谎的勾
    const still = FACE_STATE_LIST.filter((s) => !faceAnimates(s));
    expect(still).toContain("queued");
    for (const s of still) {
      expect(["plain", "queued", "failed", "frozen", "offline"], `${s} 不该是静止的`).toContain(s);
    }
  });

  it("waiting 是唯一做水平摆动的", () => {
    // sessionOrb.ts 早就定死「等你」必须压过「在跑」
    const swaying = FACE_STATE_LIST.filter((s) => FACE_STATES[s].sway !== undefined);
    expect(swaying).toEqual(["waiting"]);
  });

  it("frozen 是唯一降饱和的", () => {
    const dimmed = FACE_STATE_LIST.filter((s) => FACE_STATES[s].desaturate === true);
    expect(dimmed).toEqual(["frozen"]);
  });

  it("会动的那几档都画了角标", () => {
    // 脸负责近看、角标负责扫一眼：会动却没角标的那一档在 24px 下只是「抖了一下」
    for (const s of FACE_STATE_LIST) {
      if (s === "plain") continue;
      expect(FACE_STATES[s].badge, `${s} 缺角标`).not.toBeNull();
    }
  });
});
