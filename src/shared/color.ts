// 实色加透明度（手机端 theme.ts 的 withAlpha 搬到这里，#1237 M1 终审回流）。
//
// 纯函数、跟着根门禁跑：原来住在 mobile/ 里没有测试，而它的失败是安静的——认不出的写法原样退回，
// 界面上只是「那块板怎么不透明」，没有任何报错。

/**
 * 颜色 + 透明度 → `rgba(r, g, b, a)`。认三种写法：`#rrggbb`、`#rgb`、`rgb()` / `rgba()`（后者把原有的
 * 透明度乘上去——palette 里 mutedForeground / border / input 本来就带透明度，传进来不该被当成不透明）。
 * 认不出的原样退回：宁可少一层透明，也不让一个颜色写法把界面弄崩。
 */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  const long = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (long) return rgba(hex(long[1]), hex(long[2]), hex(long[3]), alpha);
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c);
  if (short) return rgba(hex2(short[1]), hex2(short[2]), hex2(short[3]), alpha);
  const fn = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d*\.?\d+)\s*)?\)$/i.exec(c);
  if (fn) return rgba(Number(fn[1]), Number(fn[2]), Number(fn[3]), (fn[4] === undefined ? 1 : Number(fn[4])) * alpha);
  return c;
}

function hex(s: string | undefined): number {
  return parseInt(s ?? "0", 16);
}

function hex2(d: string | undefined): number {
  const x = d ?? "0";
  return parseInt(x + x, 16);
}

function rgba(r: number, g: number, b: number, a: number): string {
  // 乘出来的透明度只留三位小数：0.14 × 0.5 在浮点里是 0.07000000000000001
  return `rgba(${r}, ${g}, ${b}, ${Math.round(a * 1000) / 1000})`;
}
