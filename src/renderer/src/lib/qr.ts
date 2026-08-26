// 把一串字变成二维码的模块矩阵(issue #583)。画成什么样是组件的事,这里只出数据。
//
// 为什么单独一层:配对码的失败方式是**扫不出来**,而那在单测里看不见 ——
// 能钉住的是"同一串字每次出同一个矩阵""留白够宽""版本会跟着长度长"。
// 真正的可扫性由 e2e/真机负责,不假装单测能覆盖。
//
// 用 qrcode-generator(零依赖、纯 JS)而不是自己写:Reed-Solomon 那一段自己实现
// 只会多一个不值得维护的失败面,而它不碰任何宿主 API,渲染进程用得起(ADR-0001)。

import qrcode from "qrcode-generator";

/** 四个模块的静区是规范要求的下限,少了很多扫码器直接认不出 */
export const QUIET_ZONE = 4;

/**
 * 纠错级别取 M(~15%)。配对码是屏幕上的一张图、不是印在纸箱上被磨花的标签,
 * 更高的纠错只会把版本推大、模块变小,反而更难扫。
 */
const ERROR_CORRECTION = "M";

/**
 * `true` = 深色模块。**含静区** —— 让"别忘了留白"变成默认路径,
 * 而不是每个调用方自己记得加。
 *
 * `typeNumber: 0` = 让库按长度自己挑最小版本;字太长(超过 40 版的容量)时它会抛,
 * 那时候该修的是那串字,不是在这儿吞掉。
 */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const side = n + QUIET_ZONE * 2;
  const out: boolean[][] = [];
  for (let y = 0; y < side; y += 1) {
    const row: boolean[] = [];
    for (let x = 0; x < side; x += 1) {
      const inside = x >= QUIET_ZONE && x < QUIET_ZONE + n && y >= QUIET_ZONE && y < QUIET_ZONE + n;
      row.push(inside && qr.isDark(y - QUIET_ZONE, x - QUIET_ZONE));
    }
    out.push(row);
  }
  return out;
}
