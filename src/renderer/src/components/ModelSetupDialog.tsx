// ModelSetupDialog — 首登引导第二步:配第一个大模型(issue #328)。
//
// 触发与盖章都在 store(setProfileSetupOpen 的接力点 + setModelSetupOpen 的
// localStorage 章,见 lib/modelSetup.ts):profile 弹窗关掉后,一把 key 都没配的
// 新用户接着看到这里。任何方式关掉都只弹这一次——引导是提醒,不是收费站。
//
// 弹窗内直接配而不是跳设置页:新用户还不认识设置页在哪,多一跳就多一半流失。
// 版式是设置页厂商列表的紧凑版(ProviderMark + 名字 + blurb + 状态点),点一行
// 展开行内 key 输入框。不变量沿用 keyVault:存完即清,渲染层不留 key 副本。

import { useEffect, useRef, useState } from "react";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { PROVIDER_CATALOG, type ProviderId, type ProviderInfo } from "../../../shared/providerCatalog.js";
import { useChat } from "../store.js";
import { ProviderMark } from "./ProviderMark.js";

/** 外壳只管开合;内容拆一层让 radix 的 Presence 在每次打开时重新挂载,
    展开态/草稿都是新鲜的(同 ProfileSetupDialog 的两条理由) */
export function ModelSetupDialog() {
  const open = useChat((s) => s.modelSetupOpen);
  const setOpen = useChat((s) => s.setModelSetupOpen);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <DialogContent className="sm:max-w-[460px]">
        <ModelSetupBody />
      </DialogContent>
    </Dialog>
  );
}

function ModelSetupBody() {
  const keyStatus = useChat((s) => s.keyStatus);
  const setOpen = useChat((s) => s.setModelSetupOpen);
  const [expanded, setExpanded] = useState<ProviderId | null>(null);

  // "配好了没" = 这一趟里任何一家的遮罩非空(keyless 不算,见 lib/modelSetup.ts)
  const anyConfigured = Object.values(keyStatus).some((mask) => mask !== "");

  return (
    <>
      <DialogHeader>
        <DialogTitle>先接一个大模型</DialogTitle>
        <DialogDescription>
          Mr Otto 得有个大脑才能干活。挑一家、贴上 API key 就行——key 只存本机，
          不进日志不上传，之后随时能在「模型配置」里增删。
        </DialogDescription>
      </DialogHeader>

      <div className="max-h-[300px] overflow-y-auto rounded-[12px] border border-border">
        <div className="divide-y divide-border/60">
          {PROVIDER_CATALOG.map((info) => (
            <ProviderSetupRow
              key={info.id}
              info={info}
              mask={keyStatus[info.apiKeyEnv] ?? ""}
              open={expanded === info.id}
              onToggle={() => setExpanded((cur) => (cur === info.id ? null : info.id))}
            />
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          以后再说
        </Button>
        {/* 没配之前灰着而不是藏着:它同时是"配好了才算完"的进度提示 */}
        <Button disabled={!anyConfigured} onClick={() => setOpen(false)}>
          开始用
        </Button>
      </DialogFooter>
    </>
  );
}

/** 一家一行:收起只说"是谁、配没配",展开才谈 key(设置页同款信息架构的紧凑版) */
function ProviderSetupRow({
  info,
  mask,
  open,
  onToggle,
}: {
  info: ProviderInfo;
  mask: string;
  open: boolean;
  onToggle: () => void;
}) {
  const configured = mask !== "";

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-[10px] px-3 py-[9px] text-left transition-colors duration-150 hover:bg-foreground/[0.04]"
      >
        <ProviderMark provider={info.id} size={24} className="rounded-[7px]" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-[550]">{info.name}</span>
          <span className="truncate text-[11px] text-muted-foreground">{info.blurb}</span>
        </span>
        {info.keyless ? (
          <span className="flex shrink-0 items-center gap-[5px] text-[11px] text-ok">
            <span className="size-[6px] rounded-full bg-ok" />
            免 key
          </span>
        ) : configured ? (
          <span className="flex shrink-0 items-center gap-[5px] text-[11px] text-ok">
            <span className="size-[6px] rounded-full bg-ok" />
            已配置
          </span>
        ) : null}
      </button>

      {open && (
        <div className="px-3 pb-[10px]">
          {info.keyless ? (
            // Ollama:没有 key 可贴,这一格的动作是"去装"
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11.5px] text-primary hover:underline"
              onClick={() => void window.otter.openProviderConsole(info.id)}
            >
              装好本机 Ollama 即可直接用，去下载
              <ExternalLinkIcon className="size-[11px]" />
            </button>
          ) : (
            <ProviderKeyInput info={info} configured={configured} />
          )}
        </div>
      )}
    </div>
  );
}

function ProviderKeyInput({ info, configured }: { info: ProviderInfo; configured: boolean }) {
  const saveApiKey = useChat((s) => s.saveApiKey);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const save = async () => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    await saveApiKey(info.apiKeyEnv, key);
    setBusy(false);
    // 存完即清(keyVault 不变量):渲染层不留 key 的任何副本
    setDraft("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="flex flex-col gap-[8px]">
      <div className="flex items-center gap-2">
        <Input
          ref={inputRef}
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="h-8 font-mono text-[12.5px]"
          placeholder={configured ? `输入新 key 覆盖（${info.keyHint}）` : `粘贴 API key（${info.keyHint}）`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <Button
          size="sm"
          className="h-8 shrink-0"
          disabled={busy || draft.trim() === ""}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : saved ? <CheckIcon className="size-[13px]" /> : "保存"}
        </Button>
      </div>
      <button
        type="button"
        className="inline-flex items-center gap-1 self-start text-[11.5px] text-primary hover:underline"
        onClick={() => void window.otter.openProviderConsole(info.id)}
      >
        还没有？去 {info.name} 控制台领 key
        <ExternalLinkIcon className="size-[11px]" />
      </button>
    </div>
  );
}
