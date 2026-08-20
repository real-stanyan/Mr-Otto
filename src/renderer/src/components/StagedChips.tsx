// StagedChips — 待发送附件的 chips 行。两个 composer(新会话 / 会话中)共用一份:
// 暂存区是全局状态(store.staged),在哪个 composer 里加的都是同一批东西。
//
// 画的活交给 elements/composer 的 ComposerAttachments + ComposerAttachmentChip:
// 一行名字 + 一个 × 说不清"这是什么、多大";元件那张 chip 是【图标位 + 名字 +
// 副行元信息 + 悬停才出现的移除】,一眼能认出贴进去的是哪一个。
// 图片走 thumbnail 口子放真缩略图 —— 认自己刚贴的那张图,看图比看图标快。
//
// 本仓的附件没有"上传中"这一档:pickFiles/粘贴/拖入都是主进程闸门当场判完才进
// store(intakeFile),进得来的就已经是成品,进不来的连 chip 都没有(理由走 attachError)。
// 所以每张 chip 都是 state="done"。

import { useChat } from "../store.js";
import {
  ComposerAttachmentChip,
  ComposerAttachments,
} from "./elements/composer.js";

/** 文本附件的副行:多大。图片没有字节数(入库时只留 ref),写它的用途 */
const kb = (bytes: number) => `${(bytes / 1024).toFixed(0)} KB`;

export function StagedChips({ className = "" }: { className?: string }) {
  const staged = useChat((s) => s.staged);
  const attachError = useChat((s) => s.attachError);
  const removeStaged = useChat((s) => s.removeStaged);
  if (staged.length === 0 && !attachError) return null;
  return (
    <ComposerAttachments className={`items-center ${className}`}>
      {staged.map((a, i) => {
        const name = a.kind === "image" ? (a.ref.name ?? "图片") : a.name;
        return (
          <ComposerAttachmentChip
            // 下标当 key:同名文件可以贴两份,名字不是身份
            key={`${i}-${name}`}
            attachment={{
              name,
              meta: a.kind === "image" ? "图片" : kb(a.bytes),
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
