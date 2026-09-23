// ottoFace（渲染层这一半）。纯层在 `src/shared/ottoFace/`（#1356 挪过去，两端共用），
// 这里只多 canvas 那一层（`paint.ts`）。桌面的调用点照旧 import 这个文件。

export * from "../../../../shared/ottoFace/index.js";
export { paintFace, sizeFaceCanvas } from "./paint.js";
