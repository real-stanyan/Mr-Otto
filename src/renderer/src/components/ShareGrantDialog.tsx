// ShareGrantDialog —— `@好友` 分享会话前的那一次确认（issue #694，ADR-0177）。
//
// 这个弹窗存在的唯一理由是**知情同意**。分享会话今天的心智是「给你看我干了啥」：
// 一次性、只读、过隐私闸。而连带借出服务之后，同一个动作的实际后果是
// 「你可以用我的身份在我的 Shopify 上下单」——而且白名单内**没有逐次审批**
// （ADR-0151），A 点这一次，B 之后调多少笔都不会再问。
//
// 两件事之间差得太远，不能靠一个隐式默认糊过去。所以：默认全勾（省事那一半留着），
// 但把后果原话摆在按钮上方（知情那一半补回来），并且按钮上写清这次到底借了几项。
//
// 反过来也一样重要：**没用到服务的会话不弹这个框**（调用方判），纯对话分享
// 一步都没多。为一个不存在的授权去点一次确认，只会训练人闭眼点确认。

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { MCP_CATALOG } from "../../../shared/mcpCatalog.js";
import { McpEntryIcon } from "./McpEntryIcon.js";

/** 服务 id → 目录条目的图标键。从目录装的 server 用条目 id 当配置键，所以
    直接按 id 对；手写配置对不上目录的，交给 McpEntryIcon 的首字母色块兜底 */
function catalogIcon(serverId: string): string | undefined {
  return MCP_CATALOG.find((e) => e.id === serverId)?.icon;
}

export interface ShareGrantTarget {
  uid: string;
  name: string;
  /** 随包发出去的留言（`@名字` 摘掉之后的正文） */
  message: string;
  /** 这个会话用到的、此刻还连着的服务（serversUsedInSession 的产物） */
  servers: readonly string[];
}

export function ShareGrantDialog({
  target,
  online,
  onCancel,
  onConfirm,
}: {
  target: ShareGrantTarget | null;
  /** 对方此刻在不在线。代理是同步的：B 用借来的工具时 A 得在线，反过来
      A 分享时对方在不在，决定了这句话该说「现在就能用」还是「等 TA 上线」 */
  online: boolean;
  onCancel: () => void;
  /** 回 true = 分享成功（调用方负责清输入框）。selected 为空 = 只分享对话 */
  onConfirm: (selected: readonly string[]) => Promise<boolean>;
}) {
  // 默认全勾：这就是「默认授权」那一半。减是随手的，加是显式的
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setSelected(target?.servers ?? []);
    setBusy(false);
  }, [target]);

  if (!target) return null;

  const toggle = (id: string): void =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const confirm = async (): Promise<void> => {
    setBusy(true);
    const ok = await onConfirm(selected);
    setBusy(false);
    if (!ok) return; // 失败留在框里，原因由调用方落进 friendError 的横幅
    onCancel();
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !busy) onCancel(); }}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>分享会话给 {target.name}</DialogTitle>
          <DialogDescription>
            对方会拿到这次会话的一份快照。下面这些服务可以连带借给 TA 用 ——
            凭证留在你这台机器上，对方拿到的是调用结果。
          </DialogDescription>
        </DialogHeader>

        {target.message && (
          <div className="rounded-md bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/80">
            “{target.message}”
          </div>
        )}

        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">这个会话用到的服务：</div>
          {target.servers.map((id) => (
            <label
              key={id}
              className="flex items-center gap-2 px-2 py-[6px] rounded-md text-xs cursor-pointer select-none hover:bg-foreground/[0.04]"
            >
              <input
                type="checkbox"
                checked={selected.includes(id)}
                onChange={() => toggle(id)}
                className="size-[13px] shrink-0 accent-[var(--brand)]"
                aria-label={id}
              />
              <McpEntryIcon icon={catalogIcon(id)} label={id} size={16} />
              <span className="truncate">{id}</span>
            </label>
          ))}
        </div>

        {/* 三句实话。写在按钮上方而不是帮助文档里——这是这个弹窗的全部意义 */}
        <ul className="text-[11px] leading-relaxed text-muted-foreground space-y-[2px] list-disc pl-4">
          <li>勾上的服务，对方和对方的水獭可以直接调用，<b>不会再逐次问你</b>；每一笔都记在「好友代理 → 已授权」的审计里，可随时一键撤销。</li>
          <li>对方调用时你得开着 app。{online ? `${target.name} 现在在线。` : `${target.name} 现在不在线，等 TA 上线才用得上。`}</li>
          <li>这张授权邀请 24 小时内有效，<b>你退出 app 它就作废</b>（一次性密钥只在内存里）——那时对方点「接上服务」会失败，找你重发即可。</li>
        </ul>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void confirm()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {busy
              ? "分享中…"
              : selected.length === 0
                ? "只分享对话"
                : `分享并借出 ${selected.length} 项服务`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
