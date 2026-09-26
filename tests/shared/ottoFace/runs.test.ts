// 帧 → 画得出来的几层。断言的都是「画出来少一格 / 多一格也不会报错」的那类：
// 行程拼回去必须逐格等于原帧，描边必须恰好是轮廓外一圈。
import { describe, expect, it } from "vitest";
import {
  composeFrame,
  FACE_CHARACTERS,
  FACE_STATE_LIST,
  GRID_H,
  GRID_W,
  type FaceFrame,
} from "../../../src/shared/ottoFace/index.js";
import { faceLayers, faceRim, runsPath, type FaceRun } from "../../../src/shared/ottoFace/runs.js";

function frame(cells: [number, number, string][], palette: Record<string, string>): FaceFrame {
  return { cells: cells.map(([x, y, key]) => ({ x, y, key })), palette, badge: null, dim: false };
}

function expand(runs: readonly FaceRun[]): string[] {
  const out: string[] = [];
  for (const [x, y, n] of runs) for (let i = 0; i < n; i++) out.push(`${x + i},${y}`);
  return out;
}

describe("faceLayers", () => {
  it("同一行同色相邻的格子合成一段，按色调分层", () => {
    const layers = faceLayers(
      frame([[0, 0, "a"], [1, 0, "a"], [3, 0, "a"], [1, 1, "b"]], { a: "#111111", b: "#222222" })
    );
    expect(layers).toEqual([
      { tone: "a", color: "#111111", runs: [[0, 0, 2], [3, 0, 1]] },
      { tone: "b", color: "#222222", runs: [[1, 1, 1]] },
    ]);
  });

  it("色板里查不到的色调不画（同 paint.ts：透明而不是崩）", () => {
    expect(faceLayers(frame([[0, 0, "z"]], { a: "#111111" }))).toEqual([]);
  });

  it("每个坑位每个态：拼回去逐格等于原帧", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      for (const s of FACE_STATE_LIST) {
        const f = composeFrame(slot, s, 1234);
        const got = faceLayers(f).flatMap((l) => expand(l.runs).map((p) => `${p},${l.tone}`)).sort();
        const want = f.cells.map((c) => `${c.x},${c.y},${c.key}`).sort();
        expect(got, `坑位 ${slot} / ${s}`).toEqual(want);
      }
    }
  });
});

describe("runsPath", () => {
  it("一段一个闭合矩形", () => {
    expect(runsPath([[1, 2, 3]])).toBe("M1 2h3v1h-3z");
    expect(runsPath([[0, 0, 1], [4, 5, 2]])).toBe("M0 0h1v1h-1zM4 5h2v1h-2z");
  });

  it("没有行程就是空串", () => {
    expect(runsPath([])).toBe("");
  });
});

describe("faceRim", () => {
  it("一格的描边是它四邻那四格", () => {
    expect(faceRim(frame([[5, 5, "a"]], { a: "#111111" }))).toEqual([
      [5, 4, 1], [4, 5, 1], [6, 5, 1], [5, 6, 1],
    ]);
  });

  it("贴着网格边的不往外画", () => {
    expect(faceRim(frame([[0, 0, "a"]], { a: "#111111" }))).toEqual([[1, 0, 1], [0, 1, 1]]);
  });

  it("真实的脸：描边不压在脸上、每格都挨着脸、脸外一圈一格不落、全在网格里", () => {
    for (let slot = 0; slot < FACE_CHARACTERS.length; slot++) {
      const f = composeFrame(slot, "alive", 0);
      const filled = new Set(f.cells.map((c) => `${c.x},${c.y}`));
      const rim = new Set(expand(faceRim(f)));
      for (const p of rim) {
        const [x, y] = p.split(",").map(Number) as [number, number];
        expect(filled.has(p), `坑位 ${slot} 描边压在脸上 ${p}`).toBe(false);
        expect(x >= 0 && x < GRID_W && y >= 0 && y < GRID_H, `坑位 ${slot} 出界 ${p}`).toBe(true);
        const touches = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].some(([a, b]) => filled.has(`${a},${b}`));
        expect(touches, `坑位 ${slot} 描边悬空 ${p}`).toBe(true);
      }
      for (const c of f.cells) {
        for (const [a, b] of [[c.x - 1, c.y], [c.x + 1, c.y], [c.x, c.y - 1], [c.x, c.y + 1]] as const) {
          if (a < 0 || a >= GRID_W || b < 0 || b >= GRID_H) continue;
          const p = `${a},${b}`;
          if (!filled.has(p)) expect(rim.has(p), `坑位 ${slot} 漏了 ${p}`).toBe(true);
        }
      }
    }
  });
});
