// NewGroupDialog —— 侧栏「群聊」节头那颗 ＋、以及私聊头部那颗「拉人」的落点
// （#1280 A4，ADR-0297）。
//
// **弹窗，不是开局卡。** 私聊那条路点一只就进去、一个字都不建（ADR-0218 的规矩：
// 那颗 ＋ 只是把主区换成 composer）；群不一样——群是建了才有身份的东西，它有一个
// 名字和一份名单，而这两样都得先问人。开局卡上没有地方问。
//
// 三条判据在这一扇窗上：
// ① **下限 2**（CHAT_GROUP_CREATE_MIN）：一只的「群」就是私聊，而私聊那条路另有
//    一条唯一索引管着，建出来的是一条谁都进不去的影子聊天。
// ② **上限 6**（CHAT_GROUP_MAX）：满了之后没勾的那几只**当场按不动**，而不是让
//    「建群」按下去拿一句服务端拒绝——那颗钮此刻看着是好的，这就是撒谎的勾（#722）。
//    已经勾上的那几只照样点得动，否则满员之后名单就再也改不了。
// ③ **群名留空用成员名顶上**：侧栏那一行不能是一格空白（同 sessionTitle.ts 的兜底），
//    而拼名字**按名册顺序不按勾选顺序**——同一份名单在两台设备上不该拼出两个名字。
//
// 「要和别人一起用？建一个团队」是这一栏唯一通向团队的路：这扇窗建不出团队，而
// 「几个人一起用」是一个人站在这儿时真会有的念头，不给出路就是死胡同（同
// NewWorkspaceDialog 的四态各有各的出口）。

import { useState } from "react";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useChat } from "../store.js";
import { AgentFace } from "./AgentFace.js";
import { agentFaceSlot } from "../lib/agentAvatar.js";
import { homeOf } from "../lib/agentRoster.js";
import { CHAT_GROUP_CREATE_MIN, CHAT_GROUP_MAX, CHAT_NAME_MAX } from "../../../shared/chatRoster.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function NewGroupDialog({ onNewTeam }: {
  /** 「建一个团队」：调用方负责开那扇窗（这一层只管把自己关上） */
  onNewTeam: () => void;
}) {
  const open = useChat((s) => s.newGroupOpen);
  const preset = useChat((s) => s.newGroupPreset);
  const groups = useChat((s) => s.workspaceGroups);
  const close = useChat((s) => s.closeNewGroup);
  const home = homeOf(groups);

  // 没有主场就没有地方建——这扇窗压根不该画得出来（侧栏那颗 ＋ 也只在 ready 时画，
  // 这里是第二道：状态可能在窗开着的时候变）
  if (home === null) return null;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      {/* key 挂在 preset 上：「拉人」带着不同的那一只再开一次时，草稿从新的预选起头
          （同 NewWorkspaceDialog 把 key 挂在 open 上的理由） */}
      <DialogContent className="sm:max-w-md" key={preset.join(",")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            新群聊
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            拉几只智能体到一个群里，它们看得见彼此说的话，会互相 @ 着接力。各自的记忆还是各自的。
          </DialogDescription>
        </DialogHeader>
        <NewGroupForm
          home={home}
          preset={preset}
          onNewTeam={() => { close(); onNewTeam(); }}
          onCancel={close}
        />
      </DialogContent>
    </Dialog>
  );
}

/** 草稿单拆一层：`useState` 的初值只在挂载那一次读得到，写在上一层的话
    open 从 false 翻到 true 时组件已经挂着、吃不到那一次（同 NewWorkspaceForm）。 */
function NewGroupForm({ home, preset, onNewTeam, onCancel }: {
  home: WorkspaceSnapshot;
  preset: string[];
  onNewTeam: () => void;
  onCancel: () => void;
}) {
  const createGroupChat = useChat((s) => s.createGroupChat);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>(preset);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 名单**按名册顺序**算，不按勾选顺序：同一份名单在两台设备上要拼出同一个名字，
  // 也要让服务端那侧的「名单第一只」是同一只（narrowRoster 的规矩）
  const ids = home.agents.map((a) => a.agentId).filter((id) => picked.includes(id));
  const full = ids.length >= CHAT_GROUP_MAX;
  const enough = ids.length >= CHAT_GROUP_CREATE_MIN;
  const trimmed = name.trim();
  const status = !enough ? `至少选${CHAT_GROUP_CREATE_MIN === 2 ? "两" : CHAT_GROUP_CREATE_MIN}只`
    : full ? "最多六只"
    : `已选 ${ids.length} 只`;

  const submit = async (): Promise<void> => {
    if (!enough || busy) return;
    setBusy(true);
    setError(null);
    // 留空用成员名顶上（同 groupRows 的兜底，两处拼法一致）
    const r = await createGroupChat(trimmed !== "" ? trimmed : nameOf(home, ids), ids);
    setBusy(false);
    // 成功的话 createGroupChat 已经把这扇窗关掉了；失败那句话留在这儿，窗不关——
    // 关掉就等于把「没建成」说成「建成了」，人会去侧栏找一个不存在的群
    if (!r.ok) setError(r.message);
  };

  return (
    <form
      className="contents"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
    >
      <Input
        autoFocus
        value={name}
        disabled={busy}
        maxLength={CHAT_NAME_MAX}
        onChange={(e) => setName(e.target.value)}
        placeholder="群名，比如「上线冲刺」"
        aria-label="群名"
      />
      {/* 列表自己滚，头尾钉住。`min-h-0` 不是装饰：DialogContent 被 max-h 夹着，
          只有 flex 下的这一层缩得动（ADR-0279 的三层分工） */}
      <div className="-mx-1 min-h-0 max-h-[38vh] overflow-y-auto px-1">
        {home.agents.map((a) => {
          const on = picked.includes(a.agentId);
          // 满员之后只有「取消勾选」还开着：全锁死的话名单就再也改不了
          const locked = busy || (full && !on);
          return (
            <label
              key={a.agentId}
              className={`flex items-center gap-2 rounded-md px-2 py-[6px] select-none ${
                locked ? "cursor-default opacity-45" : "cursor-pointer hover:bg-foreground/[0.04] active:bg-foreground/[0.07]"
              }`}
            >
              <input
                type="checkbox"
                checked={on}
                disabled={locked}
                onChange={() => setPicked((p) => (on ? p.filter((x) => x !== a.agentId) : [...p, a.agentId]))}
                className="size-[13px] shrink-0 accent-[var(--brand)]"
                aria-label={a.name}
              />
              <AgentFace slot={agentFaceSlot(home, a.agentId)} size={22} className="rounded-[5px]" />
              <span className="min-w-0 flex-1 flex flex-col gap-[1px]">
                <span className="min-w-0 truncate text-[12.5px]">{a.name}</span>
                {a.description !== "" && (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">{a.description}</span>
                )}
              </span>
            </label>
          );
        })}
      </div>
      {error !== null && <p className="text-[12px] text-err break-words">{error}</p>}
      {/* 状态那一句在左、两颗钮在右：字数会变（「至少选两只」→「已选 2 只」），
          justify-between 保证它变的时候钮不跟着挪 */}
      <DialogFooter className="sm:justify-between">
        <span className="text-[11.5px] text-muted-foreground self-center">{status}</span>
        <span className="flex gap-2">
          <Button type="button" variant="ghost" className="press-scale" disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" className="press-scale transition-opacity duration-150 ease-out" disabled={!enough || busy}>
            {busy ? "建群中…" : "建群"}
          </Button>
        </span>
      </DialogFooter>
      <div className="border-t border-border/60 pt-2 -mb-1">
        <button
          type="button"
          className="text-[11.5px] text-muted-foreground hover:text-foreground"
          onClick={onNewTeam}
        >
          要和别人一起用？建一个团队
        </button>
      </div>
    </form>
  );
}

/** 没起名字时的群名：成员名顿号拼起来（与 `groupRows` 那份兜底同一个拼法）。
    两处各写一遍的话，起过名的群和没起过名的群会在侧栏和头部拼出两个样子 */
function nameOf(home: WorkspaceSnapshot, ids: readonly string[]): string {
  return ids.map((id) => home.agents.find((a) => a.agentId === id)?.name ?? id).join("、");
}
