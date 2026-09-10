// StagedChips — 输入框上方那一行 chips。两个 composer(新会话 / 会话中)共用一份:
// 暂存区是全局状态(store.staged / store.quotes),在哪个 composer 里加的都是同一批东西。
//
// 这一行上有两种东西,它们只是长得一样:附件(图片/文本文件)会 travel 回主进程
// 变成 OutgoingAttachment,而**引用**(issue #881)一个字节都不出渲染层——发送
// 那一刻折成正文里的引用块。放在同一行是因为用户的问题是同一个("这条消息还
// 带着什么"),类型上分开是因为它们走两条完全不同的路(ADR-0284)。
//
// 画的活交给 elements/composer 的 ComposerAttachments + ComposerAttachmentChip:
// 一行名字 + 一个 × 说不清"这是什么、多大";元件那张 chip 是【图标位 + 名字 +
// 副行元信息 + 悬停才出现的移除】,一眼能认出贴进去的是哪一个。
// 图片走 thumbnail 口子放真缩略图 —— 认自己刚贴的那张图,看图比看图标快。
//
// 本仓的附件没有"上传中"这一档:pickFiles/粘贴/拖入都是主进程闸门当场判完才进
// store(intakeFile),进得来的就已经是成品,进不来的连 chip 都没有(理由走 attachError)。
// 所以每张 chip 都是 state="done"。

import { Quote } from "lucide-react";
import { useChat } from "../store.js";
import { formatBytes } from "../lib/byteSize.js";
import { quoteChipLines } from "../lib/quote.js";
import {
  ComposerAttachmentChip,
  ComposerAttachments,
} from "./elements/composer.js";

export function StagedChips({ className = "" }: { className?: string }) {
  const staged = useChat((s) => s.staged);
  const quotes = useChat((s) => s.quotes);
  const attachError = useChat((s) => s.attachError);
  const removeStaged = useChat((s) => s.removeStaged);
  const removeQuote = useChat((s) => s.removeQuote);
  if (staged.length === 0 && quotes.length === 0 && !attachError) return null;
  return (
    <ComposerAttachments className={`items-center ${className}`}>
      {/* 引用排在附件前面 —— 与它们进正文的顺序一致(引用块在正文之前,
          composeQuotedMessage);一排 chips 的读序和发出去的读序是同一个 */}
      {quotes.map((q) => {
        const { name, meta } = quoteChipLines(q.text);
        return (
          <ComposerAttachmentChip
            // id 当 key:引用可以逐字相同(同一段话引两遍),文字不是身份
            key={q.id}
            attachment={{ name, meta, state: "done", kind: "text" }}
            // 图标位塞 Quote:引用不是文件,画一枚文件类型图标(chip 会按
            // 名字猜后缀)会让它看起来像用户贴了个 .ts 进来
            thumbnail={<Quote className="size-4" />}
            // 全文只有这一个出口:chip 上那行名字是截断的
            title={q.text}
            onRemove={() => removeQuote(q.id)}
            className="transition-[opacity,transform] duration-150 ease-[var(--ease-strong)] starting:translate-y-[2px] starting:opacity-0"
          />
        );
      })}
      {staged.map((a, i) => {
        const name = a.kind === "image" ? (a.ref.name ?? "图片") : a.name;
        return (
          <ComposerAttachmentChip
            // 下标当 key:同名文件可以贴两份,名字不是身份
            key={`${i}-${name}`}
            attachment={{
              name,
              // 文本附件的副行:多大。图片没有字节数(入库时只留 ref),写它的用途
              meta: a.kind === "image" ? "图片" : formatBytes(a.bytes),
              state: "done",
              kind: a.kind,
            }}
            {...(a.kind === "image"
              ? {
                  thumbnail: (
                    <img className="size-full object-cover" src={a.previewDataUrl} alt={name} />
                  ),
                }
              : {})}
            onRemove={() => removeStaged(i)}
            className="transition-[opacity,transform] duration-150 ease-[var(--ease-strong)] starting:translate-y-[2px] starting:opacity-0"
          />
        );
      })}
      {attachError && <span className="text-err text-xs">{attachError}</span>}
    </ComposerAttachments>
  );
}
