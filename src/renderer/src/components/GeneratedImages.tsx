// GeneratedImages — 一组工具调用产出的图，挂在工具组折叠头底下。
//
// 位置与 FileTree 平级（ADR-0140）：那棵树答"这一组动了哪些文件"，这一排答
// "这一组产出了哪些图"。两者都是**结果**而不是过程，所以都常驻在折叠头外面 ——
// 出图这件事的价值全在那张图上，藏进折叠区里等于没做。
//
// 图本身走附件库懒取（useAttachmentUrls，与用户附件同一份缓存）：日志里只有
// ref（见 events.ts 的 ToolResultEvent.images），字节在附件库。
//
// 横排可滚而不是换行：一次调用出四张图时，换行会把工具组顶成一堵墙，
// 而这几张图彼此是并列的候选，横着扫比竖着读更贴近人要做的事（挑一张）。

import type { GeneratedImage } from "../aui/toolArtifacts.js";
import { ImageGeneration } from "./elements/image-generation.js";
import { useAttachmentUrls } from "../lib/useAttachmentUrls.js";

export function GeneratedImages({ images }: { images: readonly GeneratedImage[] }) {
  const urls = useAttachmentUrls(images.map((i) => i.id));
  if (images.length === 0) return null;
  return (
    <div className="flex w-full gap-2.5 overflow-x-auto pb-0.5">
      {images.map((img) => {
        const got = urls[img.id];
        return (
          <ImageGeneration
            key={img.id}
            prompt={img.caption}
            generating={got === undefined}
            lost={got === "lost"}
            {...(got !== undefined && got !== "lost" ? { src: got } : {})}
            className="shrink-0"
          />
        );
      })}
    </div>
  );
}
