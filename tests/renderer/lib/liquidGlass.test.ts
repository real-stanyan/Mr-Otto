import { describe, expect, it } from "vitest";
import {
  displacementMapSvg,
  displacementMapUri,
  filterIdFromReactId,
} from "../../../src/renderer/src/lib/liquidGlass.js";

const base = { width: 200, height: 40, radius: 14, edge: 12, blur: 8 };

describe("displacementMapSvg", () => {
  it("按真实尺寸出图（贴图被拉伸的话圆角处的折射会变形）", () => {
    const svg = displacementMapSvg(base);
    expect(svg).toContain('width="200"');
    expect(svg).toContain('height="40"');
    expect(svg).toContain('viewBox="0 0 200 40"');
  });

  it("中性区是 #808080，四边各缩进 edge —— 这一圈就是折射带", () => {
    const svg = displacementMapSvg(base);
    // 200-24 = 176，40-24 = 16
    expect(svg).toContain('x="12" y="12" width="176" height="16"');
    expect(svg).toContain('fill="#808080"');
    expect(svg).toContain("blur(8px)");
  });

  it("中性区的圆角跟着往里收（外 14 - 边 12 = 内 2）", () => {
    expect(displacementMapSvg(base)).toContain('rx="2" fill="#808080"');
  });

  it("圆角收成负数时归零，不是画一个反向圆角", () => {
    const svg = displacementMapSvg({ ...base, radius: 4, edge: 12 });
    expect(svg).toContain('rx="0" fill="#808080"');
  });

  it("圆角封顶在短边的一半", () => {
    // 高 40 → 最大 20，给 999 也只到 20
    expect(displacementMapSvg({ ...base, radius: 999 })).toContain('rx="20" fill="url(#x)"');
  });

  it("边缘带太厚时留住中性区，不让它塌成 0 宽", () => {
    // 高 40 → edge 封顶 19，中性区还剩 2px 高
    const svg = displacementMapSvg({ ...base, edge: 999 });
    expect(svg).toContain('x="19" y="19"');
    expect(svg).toContain('height="2"');
  });

  it("尺寸为 0 时退化成 1px，而不是产出一张 Chromium 会丢掉的无效图", () => {
    const svg = displacementMapSvg({ ...base, width: 0, height: 0 });
    expect(svg).toContain('width="1"');
    expect(svg).toContain('height="1"');
  });

  it("红管 x、绿管 y，绿那层走 screen 混合（两条梯度要叠在一起而不是互相盖掉）", () => {
    const svg = displacementMapSvg(base);
    expect(svg).toContain('<linearGradient id="x" x1="0" y1="0" x2="1" y2="0">');
    expect(svg).toContain('stop-color="#f00"');
    expect(svg).toContain('<linearGradient id="y" x1="0" y1="0" x2="0" y2="1">');
    expect(svg).toContain('fill="url(#y)" style="mix-blend-mode:screen"');
  });
});

describe("displacementMapUri", () => {
  it("# 必须编码：裸着放进 data URI 会被当成 fragment 截断，滤镜静默失效", () => {
    const uri = displacementMapUri(base);
    expect(uri.startsWith("data:image/svg+xml,")).toBe(true);
    expect(uri.slice("data:image/svg+xml,".length)).not.toContain("#");
    expect(decodeURIComponent(uri.slice("data:image/svg+xml,".length))).toBe(
      displacementMapSvg(base),
    );
  });
});

describe("filterIdFromReactId", () => {
  it("剥掉 React 19 的 «» 和 React 18 的 :，两代 useId 都能当 CSS 标识符用", () => {
    expect(filterIdFromReactId("«r0»")).toBe("liquid-glass-r0");
    expect(filterIdFromReactId(":r3:")).toBe("liquid-glass-r3");
  });

  it("永远不以数字开头（数字开头的 id 在 CSS 里是非法标识符）", () => {
    expect(filterIdFromReactId("123")).toBe("liquid-glass-123");
    expect(/^[a-zA-Z-]/.test(filterIdFromReactId("«r9»"))).toBe(true);
  });
});
