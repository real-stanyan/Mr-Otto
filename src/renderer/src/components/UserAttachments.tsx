// UserAttachments — 用户消息里带的图片/文件,一张卡片列表显示在气泡上方。
//
// 为什么不塞进气泡里:附件不是"话",是"随话递过来的东西"。塞进气泡等于
// 把一张图当成一句话的标点,读的人得先解析气泡才知道自己收到了什么。
//
// 为什么是**一列**卡片(elements/message-attachment),不是原来那排各自漂着的
// 独立卡片:一条消息带一图一文件时,两张卡片各自成块、还会换行,读起来像
// 连发了两三条消息 —— 而日志里它们本来就是同一条 user_message(一次发送、
// 一个 seq)。同一条消息带来的东西,要长得像同一份清单。
//
// 图片走附件库懒取(内容寻址,同图只过一次 IPC);文本文件全文就在日志里
// (UserTextFile 的快照语义)。两者都点行就地摊开核对——附件本来就在手边,
// 为了看一眼自己刚发出去的东西再开一层浮窗,是白绕一圈。

import { ImageOff } from "lucide-react";
import type {
  UserAttachmentRef,
  UserTextFile,
} from "../../../session/events.js";
import {
  MessageAttachments,
  type MessageAttachmentItem,
} from "./elements/message-attachment.js";
import { FileTypeIcon } from "./FileTypeIcon.js";
import { formatBytes } from "../lib/byteSize.js";
import { useAttachmentUrls } from "../lib/useAttachmentUrls.js";

export function UserAttachments({
  attachments,
  textFiles,
}: {
  attachments?: UserAttachmentRef[] | undefined;
  textFiles?: UserTextFile[] | undefined;
}) {
  const images = attachments ?? [];
  const files = textFiles ?? [];
  const thumbs = useAttachmentUrls(images.map((a) => a.id));
  if (images.length === 0 && files.length === 0) return null;

  const imageItem = (a: UserAttachmentRef): MessageAttachmentItem => {
    const name = a.name ?? "图片";
    const got = thumbs[a.id];
    // 图丢了退成一条普通行:名字和大小日志里还记着,只是内容没了
    if (got === "lost") {
      return {
        id: a.id,
        name: `图片缺失：${name}`,
        size: formatBytes(a.bytes),
        kind: "file",
        icon: <ImageOff className="size-3.5" />,
      };
    }
    return {
      id: a.id,
      name,
      size: formatBytes(a.bytes),
      kind: "image",
      // 还没取回来时不给 swatch:元件那边画一层同尺寸的浅底占位,图到位不顶版
      ...(got !== undefined ? { swatch: `url("${got}")` } : {}),
      // 摊开 = 看大图。缩略图和大图是同一份 data URL,不用再过一次 IPC
      ...(got !== undefined
        ? {
            detail: (
              <img
                src={got}
                alt={name}
                className="block max-h-[420px] w-full object-contain p-1"
              />
            ),
          }
        : {}),
    };
  };

  const items: MessageAttachmentItem[] = [
    // 图片先、文件后——图片一眼能认,文件要读名字,先易后难
    ...images.map(imageItem),
    ...files.map((f, i) => ({
      id: `f-${i}-${f.name}`,
      name: f.name,
      size: formatBytes(f.bytes),
      kind: "document" as const,
      // 按文件类型走的图标(material-icon-theme 那套):一排附件里哪个是配置、
      // 哪个是脚本、哪个是文档,扫一眼就分得出,不用逐个读文件名的后缀
      icon: <FileTypeIcon path={f.name} className="size-[15px]" />,
      detail: (
        <div className="max-h-60 overflow-y-auto px-3 py-2 text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {f.content}
        </div>
      ),
    })),
  ];

  // col-start-2:用户消息是两列网格(左边一列是留白/编辑钮的地盘),附件要和气泡
  // 站同一列 —— 不写这一句会被自动排版丢进第 1 列,于是附件横在气泡**左边**,
  // 看起来像另一条消息(上游那句 `[&:where(>*)]:col-start-2` 在本仓这套
  // Tailwind 下没生效,气泡自己写了 col-start-2 才没跟着跑偏)。
  // ms-auto:靠右贴齐气泡那一侧 —— 同一个人递过来的东西,同一侧
  return <MessageAttachments attachments={items} className="col-start-2 ms-auto" />;
}
