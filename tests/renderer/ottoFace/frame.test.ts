// 会动的像素脸的纯逻辑（#1345，ADR-0311）。canvas 那一层进不了 jsdom，所以
// **所有判断都在 `composeFrame` 这一侧**，这个文件就是它的保鲜期。
//
// 这一族的失败全是安静的：一行画料少一个字符、两个角色包描成一样、某一档状态
// 忘了不动——屏幕上都只是「脸有点怪」，不报错、不塌、门禁全绿。

import { describe, expect, it } from "vitest";
import {
  BROWS, EYES, FACE_CHARACTERS, FACE_COLORS, GRID_H, GRID_W, HEAD, MOUTHS,
} from "../../../src/renderer/src/lib/ottoFace/sprites.js";
import { FACE_STATES, faceAnimates, type FaceState } from "../../../src/renderer/src/lib/ottoFace/states.js";
import { composeFrame } from "../../../src/renderer/src/lib/ottoFace/frame.js";
import { paintFace } from "../../../src/renderer/src/lib/ottoFace/paint.js";

const STATES = Object.keys(FACE_STATES) as FaceState[];
/** 撒开一把时刻：各态的周期在 170..1700ms，这几个点足够把每一格图案都踩到 */
const TIMES = [0, 90, 171, 221, 301, 421, 521, 621, 823, 951, 1501, 1701, 2600, 9999];

function key(frame: ReturnType<typeof composeFrame>): string {
  return `${frame.badge ?? "-"}|${frame.dim}|${frame.cells.map((c) => `${c.x},${c.y},${c.key}`).join(" ")}`;
}

describe("画料（sprites）", () => {
  it("每一行都是 GRID_W 个字符，且只用调色板里的键", () => {
    const rows = [HEAD, ...FACE_CHARACTERS.map((c) => c.top ?? [])].flat();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // 少一个字符不会报错，只会让整行往左错一格——正好是「脸有点怪」那种失败
      expect(row).toHaveLength(GRID_W);
      for (const ch of row) {
        if (ch === ".") continue;
        expect(FACE_COLORS[ch], `未知的调色板键 ${ch}：会被当成墨黑画出来`).toBeTypeOf("string");
      }
    }
  });

  it("HEAD 就是 GRID_H 行", () => {
    expect(HEAD).toHaveLength(GRID_H);
  });

  it("13 个角色包互不相同——两个坑位长同一张脸就分不出是谁", () => {
    const seen = new Map<string, number>();
    FACE_CHARACTERS.forEach((_, slot) => {
      const k = key(composeFrame(slot, "plain", 0));
      const prev = seen.get(k);
      expect(prev, `坑位 ${slot} 和坑位 ${prev} 画出来一模一样`).toBeUndefined();
      seen.set(k, slot);
    });
  });

  it("状态表里每个图案名都查得到——查不到会静默退成「什么都不画」", () => {
    for (const state of STATES) {
      const s = FACE_STATES[state];
      for (const t of TIMES) {
        const pick = <T>(v: T | ((t: number) => T)): T => (typeof v === "function" ? (v as (t: number) => T)(t) : v);
        expect(BROWS[pick(s.brow)], `${state}.brow`).toBeDefined();
        expect(EYES[pick(s.eye)], `${state}.eye`).toBeDefined();
        expect(MOUTHS[pick(s.mouth)], `${state}.mouth`).toBeDefined();
      }
    }
  });
});

describe("composeFrame", () => {
  it("同样的坑位 / 状态 / 时刻画出同一帧——静态那一帧与动画共用这段代码", () => {
    for (const state of STATES) {
      expect(key(composeFrame(3, state, 500))).toBe(key(composeFrame(3, state, 500)));
    }
  });

  it("每一格都落在网格里（算上位移）——越界那几格会被圆盘剪掉，静静地少半张脸", () => {
    // 先收齐再断言：13 坑位 × 16 态 × 14 个时刻 × 两百多格，逐格 expect 要跑几十万次
    const outside: string[] = [];
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      for (const state of STATES) {
        for (const t of TIMES) {
          for (const c of composeFrame(slot, state, t).cells) {
            if (c.x < 0 || c.x >= GRID_W || c.y < 0 || c.y >= GRID_H) {
              outside.push(`slot ${slot} / ${state} / t=${t} → (${c.x}, ${c.y})`);
            }
          }
        }
      }
    }
    expect(outside).toEqual([]);
  });

  it("坑位越界 / 负数落回 0..12，不画空白", () => {
    expect(key(composeFrame(13, "plain", 0))).toBe(key(composeFrame(0, "plain", 0)));
    expect(key(composeFrame(-1, "plain", 0))).toBe(key(composeFrame(12, "plain", 0)));
  });
});

describe("状态的三条法理（#1307）", () => {
  it("plain 不画角标——名册那一栏查不到谁在跑，画一枚恒灰的「空闲」就是撒谎的勾", () => {
    expect(composeFrame(0, "plain", 0).badge).toBeNull();
    expect(faceAnimates("plain")).toBe(false);
  });

  it("queued 一动不动——ADR-0250 说它连打字指示器都不画，头像不能看起来像在干活", () => {
    expect(faceAnimates("queued")).toBe(false);
    const frames = new Set(TIMES.map((t) => key(composeFrame(4, "queued", t))));
    expect(frames.size).toBe(1);
  });

  it("waiting 是唯一横着摆的那一档——一墙静止头像里横向运动是最强的钩子", () => {
    const horizontal = STATES.filter((state) => {
      const move = FACE_STATES[state].move;
      if (move === null) return false;
      return TIMES.some((t) => move(t)[0] !== 0);
    });
    expect(horizontal).toEqual(["waiting"]);
  });

  it("每个真状态都有角标：40px 下光靠眼形分不出「眯眼」和「平视」", () => {
    for (const state of STATES) {
      if (state === "plain") continue;
      expect(FACE_STATES[state].badge, state).not.toBeNull();
    }
  });

  it("faceAnimates 从状态表推导：会换图案或会位移的那几档才算在动", () => {
    expect(faceAnimates("waiting")).toBe(true);
    expect(faceAnimates("speaking")).toBe(true); // 嘴在换
    expect(faceAnimates("searching")).toBe(true); // 眼在换
    expect(faceAnimates("failed")).toBe(false);
    expect(faceAnimates("frozen")).toBe(false);
  });
});

describe("paintFace", () => {
  it("拿不到 2d 上下文就什么都不画、也不抛——一张空白圆盘好过把整棵树炸掉", () => {
    const canvas = { width: 64, height: 64, getContext: () => null } as unknown as HTMLCanvasElement;
    expect(() => paintFace(canvas, 0, "plain", 0)).not.toThrow();
  });
});
