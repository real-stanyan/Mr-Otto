// shared/imageFit.ts 那台机器在桌面这侧的编解码半边(issue #882)。
//
// 为什么是 Electron 的 nativeImage 而不是 sharp/jimp:app 里已经装着一整个
// Chromium,为了缩张图再拖一个原生依赖进 DMG 不划算(#820 记着 dependencies
// 会被 electron-builder 整个打进去)。
//
// **天花板,实测的**:nativeImage.createFromBuffer 只解 png / jpeg ——
// webp 与 gif 进去出来是一张 isEmpty() 的空图(Electron 43 本机验过)。
// 所以这两种格式回 null 走 undecodable 那条路,由调用方按原来的上限处理。
// 不是漏做:11.7MB 的 webp 基本不存在(webp 本身就是压缩格式),而一张动图
// 缩完只剩第一帧 —— 那时"传进去了"反而比"没传进去"更能骗到人。
//
// 第二条天花板:JPEG 没有 alpha,带透明的 PNG 缩完透明处会变黑。缩这条路
// 只在图**已经超上限**时才走(见 fitImage 的 unchanged 分支),没超的 PNG
// 一个字节都不动,所以这个代价只在"不缩就传不了"的那些图上付。

import { nativeImage } from "electron";
import type { FitEncoder } from "../shared/imageFit.js";

export const nativeImageEncoder: FitEncoder = async (data, edge, quality) => {
  const img = nativeImage.createFromBuffer(Buffer.from(data));
  if (img.isEmpty()) return null; // 格式解不了(webp/gif/坏文件)
  const { width, height } = img.getSize();
  // **只缩不放**:比目标还小的图硬拉到 2048 只会更大更糊。
  // 只给一条边,长宽比由 nativeImage 自己保持
  const resized =
    Math.max(width, height) > edge
      ? img.resize({
          ...(width >= height ? { width: edge } : { height: edge }),
          quality: "best",
        })
      : img;
  return new Uint8Array(resized.toJPEG(Math.round(quality * 100)));
};
