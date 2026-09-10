// 从 renderer/src/lib 抬进 shared（#1229）：灵动岛的额度页脚由主进程算好推给
// Swift helper，而主进程不该 import 渲染层。同一把尺子，两侧共用一份。

/** 用量弹窗的数字格式：~119K / 1M 那一路。K 以下给整数，10 万以上不要小数
    （119.0K 的那位小数没有信息量，估算精度也撑不起它）。

    从 App.tsx 搬出来（原地是模块私有函数）：上下文浮层的 hero 数字、图例、
    型号脚注现在都用这一把尺子，而后两者住在别的文件里。**同一张卡上的数字
    只能有一种读法** —— 原来最大那个数用逗号分组（`865,481`），其余全是 K，
    读者要在一张 300px 的卡里换两次算法。 */
export function fmtCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) {
    const k = n / 1000;
    return `${k >= 100 ? Math.round(k) : k.toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(n);
}
