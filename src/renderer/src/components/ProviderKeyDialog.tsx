// 填 key 的弹窗（「模型配置」页每家厂商一枚入口钮）。
//
// 原来是展开行内直接放输入框。改成弹窗的原因是那一行后来长出了别的东西：
// 展开体最上面是这家的用量图和余额，一个常驻的输入框横在图和型号清单中间，
// 把"看账"和"改配置"两件不相干的事挤在同一屏 —— 而**看**账是天天的事，
// **改** key 是一次性的事。常驻的那个更该是前者。
//
// 不变量沿用 keyVault：输入框存完即清，渲染层不留 key 的任何副本；状态只有布尔。

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import type { ProviderInfo } from "../../../shared/providerCatalog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { ProviderMark } from "./ProviderMark.js";

export function ProviderKeyDialog({ info, mask }: { info: ProviderInfo; mask: string }) {
  // 空串 = 没配（keyStatus 的口径）。配了就把遮罩显示在钮上 ——
  // env 变量名只回答"这一格是干什么的"，回答不了"贴进去的是哪一把"
  const configured = mask !== "";
  const saveApiKey = useChat((s) => s.saveApiKey);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 每次打开都是空的:上一次输入的 key 不该留在内存里等下一次打开(存完即清的延伸)
  useEffect(() => {
    if (open) {
      setDraft("");
      window.setTimeout(() => inputRef.current?.focus(), 60);
    }
  }, [open]);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    await saveApiKey(info.apiKeyEnv, key);
    setDraft("");
    setOpen(false);
    // "已保存"落在那枚钮上而不是弹窗里:弹窗这时已经关了,提示得留在用户看得见的地方
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <>
      {/* 整行可点的入口钮。版式跟着上面那排厂商行走(同样的悬停底色、同样的 chevron),
          读起来是"这一层里的下一层",不是一个孤零零的按钮 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="press-scale flex w-full items-center gap-2 rounded-[10px] border border-border px-3 py-[9px] text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
      >
        <code className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground">
          {configured ? mask : info.apiKeyEnv}
        </code>
        {saved ? (
          <span className="saved-hint inline-flex shrink-0 items-center gap-1 text-[11.5px] text-ok">
            <CheckIcon className="size-[11px]" />
            已保存
          </span>
        ) : (
          <span className="shrink-0 text-[11.5px] text-muted-foreground">
            {configured ? "更换 key" : "填写 key"}
          </span>
        )}
        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ProviderMark provider={info.id} size={22} className="rounded-[6px]" />
              {info.name}
            </DialogTitle>
            <DialogDescription>
              key 存在本机 <code>keys.json</code>（仅当前用户可读），不进会话日志，不回传界面。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-[10px]">
            <Input
              ref={inputRef}
              type="password"
              autoComplete="off"
              spellCheck={false}
              className="h-9 font-mono text-[13px]"
              placeholder={configured ? `输入新 key 覆盖（${info.keyHint}）` : `粘贴 API key（${info.keyHint}）`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
              }}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-[6px] text-[11.5px]">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-primary hover:underline"
                onClick={() => void window.otter.openProviderConsole(info.id)}
              >
                去 {info.name} 控制台领 key
                <ExternalLinkIcon className="size-[11px]" />
              </button>
              <code className="text-muted-foreground">{info.apiKeyEnv}</code>
            </div>
          </div>

          <DialogFooter className="gap-2">
            {/* 清除排在最左、和保存离得最远:它是不可逆的那一颗 */}
            {configured && (
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  "mr-auto h-9 border-destructive/60 bg-transparent text-destructive",
                  "hover:bg-destructive/10 hover:text-destructive dark:bg-transparent dark:hover:bg-destructive/10"
                )}
                onClick={() => {
                  void saveApiKey(info.apiKeyEnv, "");
                  setOpen(false);
                }}
              >
                清除
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button size="sm" className="h-9" disabled={!draft.trim()} onClick={() => void save()}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
