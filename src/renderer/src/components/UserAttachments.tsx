// UserAttachments — 用户消息里带的图片/文件,单独成排显示在气泡上方。
//
// 为什么不塞进气泡里:附件不是"话",是"随话递过来的东西"。塞进气泡等于
// 把一张图当成一句话的标点,读的人得先解析气泡才知道自己收到了什么。
// 分开后气泡只管文本(纯用户正文),附件自带一层卡片表面——它们是物件,有厚度。
//
// 图片走附件库懒取(内容寻址,同图只过一次 IPC);文本文件全文就在日志里
// (UserTextFile 的快照语义),点开卡片就地核对,不摊开占掉整屏。

import { useEffect, useState } from "react";
import { ChevronRight, FileText, ImageOff } from "lucide-react";
import type { UserAttachmentRef, UserTextFile } from "../../../session/events.js";

/** 附件 data URL 内存缓存:同图(内容寻址同 id)只过一次 IPC */
const thumbCache = new Map<string, string>();

const CARD =
  "overflow-hidden rounded-[14px] border border-border/60 bg-card/70 backdrop-blur-sm shadow-sm";

function sizeLabel(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** 时间线里的图片卡片:懒取 + 缓存。取不到(附件库文件丢失)退成占位卡——
    日志重放依赖附件库是已接受的取舍(docs/adr/0009),缺图不该炸时间线 */
function ImageCard({ att }: { att: UserAttachmentRef }) {
  const [url, setUrl] = useState<string | null>(thumbCache.get(att.id) ?? null);
  const [lost, setLost] = useState(false);
  useEffect(() => {
    if (url) return;
    let alive = true;
    window.otter.attachmentDataUrl(att.id).then(
      (u) => {
        thumbCache.set(att.id, u);
        if (alive) setUrl(u);
      },
      () => {
        if (alive) setLost(true);
      }
    );
    return () => {
      alive = false;
    };
  }, [att.id, url]);

  if (lost) {
    return (
      <div className={`${CARD} flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground`}>
        <ImageOff className="size-4 shrink-0" aria-hidden />
        图片缺失{att.name ? `：${att.name}` : ""}
      </div>
    );
  }
  return (
    <div className={`${CARD} p-1`}>
      {url ? (
        <img
          className="block max-h-40 max-w-[220px] rounded-[10px] object-cover"
          src={url}
          alt={att.name ?? "附件图片"}
          title={att.name}
        />
      ) : (
        // 占位保持和图片同量级的体积:图到位时不会把下面的消息顶一跳
        <div className="h-24 w-32 animate-pulse rounded-[10px] bg-foreground/[0.06]" aria-hidden />
      )}
    </div>
  );
}

/** 文本文件卡片:默认只亮"带了什么",点开就地核对快照全文 */
function FileCard({ file }: { file: UserTextFile }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`${CARD} max-w-full`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2 border-none bg-transparent px-2.5 py-2 text-left transition-[background-color,transform] duration-150 ease-[var(--ease-strong)] hover:bg-foreground/5 active:scale-[0.99]"
      >
        <FileText className="size-4 shrink-0 text-brand" aria-hidden />
        <span className="min-w-0 truncate font-mono text-xs text-foreground">{file.name}</span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {sizeLabel(file.bytes)}
        </span>
        <ChevronRight
          className={
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-[var(--ease-strong)] motion-reduce:transition-none" +
            (open ? " rotate-90" : "")
          }
          aria-hidden
        />
      </button>
      {open && (
        <div className="max-h-60 overflow-y-auto border-t border-border/60 px-2.5 py-2 text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {file.content}
        </div>
      )}
    </div>
  );
}

export function UserAttachments({
  attachments,
  textFiles,
}: {
  attachments?: UserAttachmentRef[] | undefined;
  textFiles?: UserTextFile[] | undefined;
}) {
  const images = attachments ?? [];
  const files = textFiles ?? [];
  if (images.length === 0 && files.length === 0) return null;
  return (
    // 右对齐跟着用户气泡走(同一个人说的话,同一侧);图片先、文件后——
    // 图片一眼能认,文件要读名字,先易后难
    <div className="flex max-w-full flex-wrap justify-end gap-1.5">
      {images.map((a) => (
        <ImageCard key={a.id} att={a} />
      ))}
      {files.map((f, i) => (
        <FileCard key={`${f.name}-${i}`} file={f} />
      ))}
    </div>
  );
}
