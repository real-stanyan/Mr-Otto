// workFilesView —— 团队设置页「文件」tab 的纯逻辑（#1056）。
//
// 这一页答的是「水獭在哪儿干活、那儿有什么」。判据全在这里而不是组件的
// `useMemo` 里，理由同 ADR-0244 那条：留在组件里就没有保鲜期。

import type { CsWorkEntry, CsWorkNode } from "../../../shared/remote/cloudSession.js";

/** 字节数写成人话。目录不显示大小（`size` 恒为 0，调用方自己判 kind） */
export function formatWorkSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 修改时间：今年只写月日，跨年补上年份。`now` 注入，好让测试不随时间漂 */
export function formatWorkTime(mtimeMs: number, now: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return "";
  const d = new Date(mtimeMs);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 「这一格里什么都没有」时说哪句话；有东西可画就回 null。
    **三种「空」说的不是一回事，不许合成一句**：
    · `absent` = 容器还没建起来（这个团队一次活都没干过）——对一个刚建群的人
      说「你的文件夹是空的」，而那个文件夹此刻并不存在；
    · `missing` = 这条路径没了（刚才还在，翻着翻着被水獭删了）；
    · 空目录 = 真的建起来了、里面还没东西。 */
export function workFolderNotice(node: CsWorkNode): string | null {
  if (node.kind === "absent") {
    return "工作文件夹还没建起来——第一次让水獭动手干活时才会建。";
  }
  if (node.kind === "missing") {
    return "这个位置现在没有东西，可能刚被删掉或改名了。";
  }
  if (node.kind === "dir" && node.entries.length === 0) {
    return "还是空的。水獭在会话里做出来的东西会出现在这里。";
  }
  return null;
}

/** 文件正文那一格底下那句脚注（截断 / 二进制）。没什么好说的就回 null */
export function workFileNotice(node: CsWorkNode): string | null {
  if (node.kind === "binary") {
    return `这是一个二进制文件（${formatWorkSize(node.size)}），显示不出内容。`;
  }
  if (node.kind === "file" && node.truncated) {
    return `文件有 ${formatWorkSize(node.size)}，这里只显示了开头一段。`;
  }
  // 空文件画出来是一个空白框，和「组件坏了」长得一样（同 ADR-0239 那根填了
  // 0.03% 的条）——所以这一句也要说出口
  if (node.kind === "file" && node.text === "") {
    return "这是一个空文件。";
  }
  return null;
}

/** 行尾那一格：目录不写大小，只写时间；文件两样都写 */
export function entryMeta(entry: CsWorkEntry, now: number): string {
  const time = formatWorkTime(entry.mtimeMs, now);
  if (entry.kind === "dir") return time;
  const size = formatWorkSize(entry.size);
  return [size, time].filter((s) => s !== "").join(" · ");
}
