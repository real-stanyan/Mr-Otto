// 一枚按文件类型走的图标。图标来自 material-icon-theme（VS Code 那套，MIT），
// 抄进仓的那批在 assets/file-icons/，认路径的规矩在 lib/fileIcon.ts。
//
// 为什么不是 lucide 的那枚灰 FileText：界面上同时出现好几个文件路径时（工具行、
// 附件、diff 头），一模一样的灰图标只是在每行前面加了个装饰，读者仍然只能靠读
// 文件名分辨。彩色的类型图标是**可以扫**的：一列里哪个是配置、哪个是测试、
// 哪个是图片，不用逐行读字。
//
// 用 <img> 而不是内联 SVG：这些图标本身是多色的（类型色就是它们的信息），
// 不需要也不该被 currentColor 染成一个颜色；<img> 还能让 68 枚各自留在磁盘上，
// 谁出现才读谁，不进主包。

import { cn } from "@/lib/utils.js";
import { DEFAULT_FILE_ICON, FOLDER_ICON, fileIconName } from "@/lib/fileIcon.js";

// eager:true 只把**地址**收进来（?url），不是把 SVG 内容打进包里
const URLS = import.meta.glob<string>("../assets/file-icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
});

function urlOf(icon: string): string | undefined {
  return URLS[`../assets/file-icons/${icon}.svg`];
}

export function FileTypeIcon({
  path,
  className,
  folder = false,
}: {
  /** 完整路径或纯文件名都行（lib/fileIcon 自己取最后一段） */
  path: string;
  className?: string;
  /** 这一行是目录：走 assets 里那枚 folder.svg，不按扩展名查表。
      理由同上面那段注释——一列里目录和文件靠图标就能分开，不用读字 */
  folder?: boolean;
}) {
  const src = urlOf(folder ? FOLDER_ICON : fileIconName(path)) ?? urlOf(DEFAULT_FILE_ICON);
  if (src === undefined) return null; // 连兜底那枚都没有 = 生成产物坏了，宁可不画
  return (
    <img
      src={src}
      // 图标是文件名的复述,不是新信息:文件名就在旁边。给它 alt 只会让读屏器
      // 把同一件事念两遍
      alt=""
      aria-hidden
      draggable={false}
      className={cn("size-4 shrink-0 select-none", className)}
    />
  );
}

/** 文件夹那一枚（工作区选择器用）。和文件图标同一套来源、同一种画法 ——
    界面上文件和文件夹经常挨着出现（工作区那一行下面就是文件路径），
    一枚线框 lucide 配一排彩色 material 图标，像两套界面拼在一起。
    material 的这枚是蓝灰实心（#90a4ae），明暗两套主题都压得住 */
export function FolderIcon({ className }: { className?: string }) {
  const src = urlOf("folder");
  if (src === undefined) return null;
  return <img src={src} alt="" aria-hidden="true" draggable={false} className={cn("size-[14px] shrink-0", className)} />;
}
