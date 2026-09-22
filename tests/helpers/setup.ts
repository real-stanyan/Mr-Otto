// vitest setupFiles —— 每个测试文件跑一遍。两件事：
// ① 把 tempDir() 建过的一次性目录在文件跑完之后删掉（见 tempDir.ts）
// ② jsdom 没有 canvas，`getContext()` 每被调一次就往虚拟控制台吐一行
//    「Not implemented」。渲染层的像素脸（#1345，lib/ottoFace/）本来就按
//    `getContext() === null` 退化成不画，所以那一行是噪音不是信号 —— 一屏
//    头像就是二十来行，真正的失败会被埋进去。这里显式把它桩成 null：
//    **把「jsdom 画不了」这件事说出口**，而不是让每条渲染用例各自忍受它。
//    要断言脸画出来没有，判据是 DOM 上的 `canvas[data-face]`（像素画不出来
//    不影响那一条），画的内容由 `composeFrame` 的纯函数用例钉住。

import { afterAll } from "vitest";
import { cleanupTempDirs } from "./tempDir.js";

afterAll(cleanupTempDirs);

if (typeof HTMLCanvasElement !== "undefined") {
  HTMLCanvasElement.prototype.getContext = function getContext(): null {
    return null;
  } as HTMLCanvasElement["getContext"];
}
