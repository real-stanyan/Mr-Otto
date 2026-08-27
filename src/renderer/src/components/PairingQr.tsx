// 配对二维码那张图(issue #583)。只负责画,不知道码是怎么来的。
//
// **固定深色模块 + 白底**,不跟主题走:暗色模式下反相的二维码有一部分扫码器
// 认不出,而这张图的唯一职责就是被扫到。白底那圈静区也是规范要求的(lib/qr.ts)。

import { qrModules } from "../lib/qr.js";

export function PairingQr({ text, size = 232 }: { text: string; size?: number }) {
  const modules = qrModules(text);
  const side = modules.length;
  return (
    <svg
      viewBox={`0 0 ${side} ${side}`}
      width={size}
      height={size}
      role="img"
      aria-label="配对二维码"
      className="rounded-md"
      shapeRendering="crispEdges"
    >
      <rect width={side} height={side} fill="#ffffff" />
      {modules.map((row, y) =>
        row.map((dark, x) =>
          dark ? <rect key={`${y}-${x}`} x={x} y={y} width={1} height={1} fill="#000000" /> : null
        )
      )}
    </svg>
  );
}
