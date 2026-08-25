// ProfileEditor — 改头像 + 改名字的那张表单本身。
//
// 首登引导弹窗和账号设置页共用这一个组件:两处改的是同一行数据,规则(名字多长、
// 什么图能用、保存失败怎么显示)只该有一份。差别只在外壳 —— 弹窗给它配"完成/以后再说",
// 设置页给它配"保存"。所以按钮不在这里,由 children 之外的 actions 插槽传进来。

import { useEffect, useRef, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Input } from "@/components/ui/input.js";
import { AVATAR_MAX_CHARS, NAME_MAX } from "../../../shared/profile.js";
import { fileToAvatarDataUrl } from "../lib/avatarImage.js";

export interface ProfileDraft {
  name: string;
  avatarUrl: string;
}

/** 头像位。有图显示图,没图显示首字母 —— 空白圆圈会让人以为是加载中。
    走 shadcn Avatar:图链接坏掉时 Radix 自己落回首字母,不会留一个裂图标在脸上。
    圆和裁剪由外层那颗按钮做(它本来就是 rounded-full + overflow-hidden),
    这里只负责铺满 */
function AvatarWell({ draft, initial }: { draft: ProfileDraft; initial: string }) {
  return (
    <Avatar className="size-full">
      <AvatarImage src={draft.avatarUrl} alt="" referrerPolicy="no-referrer" />
      <AvatarFallback className="bg-transparent text-[26px] font-semibold text-foreground/70">
        {initial}
      </AvatarFallback>
    </Avatar>
  );
}

export function ProfileEditor({
  draft,
  onChange,
  initial,
  error,
  busy = false,
  autoFocus = false,
  actions,
}: {
  draft: ProfileDraft;
  onChange: (next: ProfileDraft) => void;
  /** 没有头像图时垫底的首字母(lib/identity.ts 算好的) */
  initial: string;
  /** 保存失败的原因。表单自己的读图错误也会显示在同一行 */
  error?: string | null;
  busy?: boolean;
  /** 挂载时把光标放进名字框。只有弹窗该开:设置页是用户自己点进来的,
      进门就抢焦点会让接下来的任何按键都掉进名字框里 */
  autoFocus?: boolean;
  actions?: React.ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // 弹窗一开就把光标放进名字框:引导的第一件事就是改名,让用户少点一下。
  // radix 的 Dialog 会在挂载后抢一次焦点,得等它抢完(下一帧)再要回来
  useEffect(() => {
    if (!autoFocus) return;
    const id = requestAnimationFrame(() => nameRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [autoFocus]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    setReadError(null);
    try {
      onChange({ ...draft, avatarUrl: await fileToAvatarDataUrl(file, AVATAR_MAX_CHARS) });
    } catch (e) {
      setReadError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const shown = readError ?? error ?? null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        {/* 头像即按钮:点脸换脸,不用先找一个"上传"按钮。
            press 时缩一档 —— 按下去就有回应,是"这东西能按"的最短证据 */}
        <button
          type="button"
          className="press-scale relative size-[72px] shrink-0 overflow-hidden rounded-full bg-accent ring-1 ring-border transition-shadow duration-150 hover:ring-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-60"
          disabled={reading || busy}
          onClick={() => fileRef.current?.click()}
          aria-label="换头像"
          title="换头像"
        >
          <AvatarWell draft={draft} initial={initial} />
          {/* 悬停/读图时压一层暗罩 + 相机。平时不挂图标:头像是给人看的,
              常驻一个相机会让它一直像个"待办" */}
          <span
            className={`absolute inset-0 flex items-center justify-center bg-black/45 text-white transition-opacity duration-150 ${
              reading ? "opacity-100" : "opacity-0 hover:opacity-100"
            }`}
          >
            {reading ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="profile-name">
            名字
          </label>
          <Input
            id="profile-name"
            ref={nameRef}
            className="h-8 text-[13px]"
            value={draft.name}
            maxLength={NAME_MAX}
            placeholder="好友看到的名字"
            disabled={busy}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
          <p className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <span>点头像换图,自动裁成方的</span>
            {draft.avatarUrl && (
              <button
                type="button"
                className="shrink-0 underline-offset-2 hover:underline"
                onClick={() => onChange({ ...draft, avatarUrl: "" })}
              >
                不要头像
              </button>
            )}
          </p>
        </div>
      </div>

      {/* accept 只是给系统文件框的过滤提示,真正的把关在 fileToAvatarDataUrl
          和主进程的 validateAvatar —— 用户永远能在文件框里选"所有文件" */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          // 清空 value:不清的话选同一个文件第二次不会触发 change
          e.target.value = "";
        }}
      />

      {shown && <p className="text-xs text-destructive">{shown}</p>}
      {actions}
    </div>
  );
}
