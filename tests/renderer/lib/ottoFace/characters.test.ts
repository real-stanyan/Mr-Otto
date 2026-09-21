// 角色花名册。引擎是共用的，角色是纯数据——所以这里断言的全是「数据写错了」的那几种，
// 而且都是肉眼要盯着 40px 的小图才看得出来、但测试一秒能抓到的：
// 矩阵缺一列、擦除框比矩阵还大、锚点加上最胖的那种表情之后戳出脸外。

import { describe, expect, it } from "vitest";
import { BADGE_SIZE, composeFrame, layoutFor } from "@/lib/ottoFace/compose.js";
import { FACE_CANVAS, FACE_CHARACTERS, faceCharacter, SAGE } from "@/lib/ottoFace/characters/index.js";
import { FACE_STATE_LIST } from "@/lib/ottoFace/states.js";
import { deriveBrows, deriveEyes, deriveMouths, type FaceCharacter } from "@/lib/ottoFace/character.js";

describe("角色花名册", () => {
  it("id 不重名", () => {
    const ids = FACE_CHARACTERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("faceCharacter 按 id 查得到，查不到的返回 undefined", () => {
    for (const c of FACE_CHARACTERS) expect(faceCharacter(c.id)).toBe(c);
    expect(faceCharacter("没有这个角色")).toBeUndefined();
  });

  it.each(FACE_CHARACTERS.map((c) => [c.id, c] as const))("%s：矩阵是矩形，宽高与声明一致", (_id, ch) => {
    expect(ch.base).toHaveLength(ch.h);
    for (const [j, row] of ch.base.entries()) expect(row.length, `第 ${j} 行`).toBe(ch.w);
  });

  it.each(FACE_CHARACTERS.map((c) => [c.id, c] as const))("%s：用到的色号都在色板里", (_id, ch) => {
    const known = new Set(Object.keys(ch.palette));
    for (const [j, row] of ch.base.entries()) {
      for (const [i, t] of [...row].entries()) {
        if (t !== ".") expect(known.has(t), `(${i},${j}) = ${t}`).toBe(true);
      }
    }
    // ink 画五官、skin 填擦除框，两个都必须能查到颜色，否则合成出来是一片透明
    expect(known.has(ch.ink)).toBe(true);
    expect(known.has(ch.skin)).toBe(true);
    for (const box of ch.erase) {
      const fill = box[4];
      if (fill !== undefined) expect(known.has(fill), `填充色 ${fill}`).toBe(true);
    }
  });

  it.each(FACE_CHARACTERS.map((c) => [c.id, c] as const))("%s：擦除框在矩阵之内且不倒着写", (_id, ch) => {
    for (const [r0, r1, c0, c1] of ch.erase) {
      expect(r0).toBeLessThanOrEqual(r1);
      expect(c0).toBeLessThanOrEqual(c1);
      expect(r0).toBeGreaterThanOrEqual(0);
      expect(c0).toBeGreaterThanOrEqual(0);
      expect(r1).toBeLessThan(ch.h);
      expect(c1).toBeLessThan(ch.w);
    }
  });

  it.each(FACE_CHARACTERS.map((c) => [c.id, c] as const))("%s：最胖的那种表情也戳不出脸外", (_id, ch) => {
    // 视线最多偏一格、眉毛最多上下挪两格，都算进去。算漏了的后果是眼睛被裁半只，
    // 而那种半只眼睛在 40px 下看着只是「有点怪」，不会有人报 bug
    const LOOK = 1, BROW = 2;
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

  it.each(FACE_CHARACTERS.map((c) => [c.id, c] as const))("%s：角标槽里只有角标", (_id, ch) => {
    // 这条原本只钉着 Otto。角标槽是按 ch.w 算的，每加一个角色就得重新成立一次——
    // 所以推广到全体，而不是加角色时顺手再抄一遍
    const L = layoutFor(ch);
    for (const s of FACE_STATE_LIST) {
      for (let t = 0; t < 2000; t += 311) {
        const f = composeFrame(ch, s, t);
        for (let y = 0; y < f.h; y++) {
          for (let x = L.badgeX; x < L.badgeX + BADGE_SIZE; x++) {
            const c = f.rows[y]?.[x] ?? ".";
            expect(c === "." || c === "A", `${ch.id}/${s}@${t} (${x},${y}) = ${c}`).toBe(true);
          }
        }
      }
    }
  });

  it("换角色就换帧，不是所有人共用一张脸", () => {
    const seen = new Set(FACE_CHARACTERS.map((c) => composeFrame(c, "idle", 0).rows.join("\n")));
    expect(seen.size).toBe(FACE_CHARACTERS.length);
  });
});

describe("擦除框的填充色", () => {
  it("第五项指定填什么色，不写就填 skin", () => {
    // 上半张脸是 o、下半张是 g；五官都画在左上角，两个擦除框都在它们够不着的地方
    const ch: FaceCharacter = {
      id: "试", name: "试", w: 10, h: 10,
      base: [...Array.from({ length: 6 }, () => "o".repeat(10)), ...Array.from({ length: 4 }, () => "g".repeat(10))],
      palette: { "#": "#000000", g: "#888888", o: "#FFFFFF" },
      ink: "#", skin: "o",
      erase: [[6, 6, 1, 8], [8, 8, 1, 8, "g"]],
      anchors: { browL: [0, 0], browR: [0, 0], eyeL: [0, 0], eyeR: [0, 0], mouth: [0, 0] },
      eyes: deriveEyes({ lw: 1, lh: 1, rw: 1, rh: 1 }),
      brows: deriveBrows(0, 0),
      mouths: deriveMouths(5),
    };
    const L = layoutFor(ch);
    const f = composeFrame(ch, "queued", 0); // queued 不呼吸也不眨眼，偏移恒为 0
    const at = (c: number, r: number): string => f.rows[L.headY + r]?.[L.headX + c] ?? "?";
    expect(at(4, 6)).toBe("o"); // 不写第五项 → skin，把本来的 g 抹成了 o
    expect(at(4, 8)).toBe("g"); // 写了 → 按写的填，不是 skin
  });

  it("大胡子的嘴填的是胡子色，不是脸色", () => {
    // 这条盯着的是回归：有人把第五项删了，sage 的胡子中间就会开一个白洞，
    // 而那个洞只在 sage 身上出现，跑 Otto 的用例一格红都不会有
    const mouth = SAGE.erase.find((b) => b[4] !== undefined);
    expect(mouth?.[4]).toBe("g");
  });
});

describe("一排头像不能一个大一个小", () => {
  // 缩放只能取整（取小数就是次像素插值，像素画当场糊掉），所以「显示成一样大」这件事
  // 在渲染这一侧补不回来，必须在数据里就对齐。这两条钉住的就是那个前提。
  it("全体角色共用同一张画布", () => {
    for (const ch of FACE_CHARACTERS) {
      expect(ch.w, `${ch.id} 宽`).toBe(FACE_CANVAS.w);
      expect(ch.h, `${ch.id} 高`).toBe(FACE_CANVAS.h);
    }
  });

  it("头部外框高度最多差三格", () => {
    // 不是「完全相等」：外框高度是提取网格的阶梯函数，会跳过某些值——齐刘海和平头
    // 在四十到六十格之间扫一遍，46、47 两个值一次都没出现过。硬凑相等只能去拉伸矩阵，
    // 那是拿一眼看得出的变形换一个看不出的差别。三格 ≈ 6%，原来是 33%
    const hs = FACE_CHARACTERS.map((ch) => {
      const ys = ch.base.flatMap((r, j) => ([...r].some((c) => c !== ".") ? [j] : []));
      return (ys.at(-1) ?? 0) - (ys[0] ?? 0) + 1;
    });
    expect(Math.max(...hs) - Math.min(...hs), `头高 ${hs.join(",")}`).toBeLessThanOrEqual(3);
  });
});
