// WorkspacesPanel —— 侧栏工作区区块：列表 + 建群（Task 12，ADR-0198 切片 3）。
//
// 视觉语法照抄 FriendsSection：同样收进 footer icon 的 Drawer（同层挂载点，
// 见 App.tsx 的装配处），同样的输入框 + SidebarMenu 列表 + 内联错误。
// 点一行 = 打开 WorkspacePage（换页不是弹窗，ADR-0185）——这个组件自己管
// "列表 or 详情页" 这一层状态，Drawer 那一侧不用知道打开到第几层。

import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { useChat } from "../store.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar.js";

const SECTION_LABEL = "text-[11px] text-muted-foreground tracking-[0.04em] pt-[10px] px-[10px] pb-[2px]";

export function WorkspacesPanel({ embedded = false }: { embedded?: boolean }) {
  const account = useChat((s) => s.account);
  const groups = useChat((s) => s.workspaceGroups);
  const error = useChat((s) => s.workspaceGroupsError);
  const refresh = useChat((s) => s.refreshWorkspaceGroups);
  const createGroup = useChat((s) => s.createWorkspaceGroup);

  const [name, setName] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (account.signedIn) void refresh();
  }, [account.signedIn, refresh]);

  if (!account.signedIn) {
    return <div className={SECTION_LABEL}>{embedded ? "登录后可用" : "工作区 · 登录后可用"}</div>;
  }

  const opened = groups.find((g) => g.id === openId) ?? null;
  if (opened) {
    return <WorkspacePage ws={opened} selfUid={account.id} onBack={() => setOpenId(null)} />;
  }

  const submitCreate = async (): Promise<void> => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    const ok = await createGroup(n);
    setBusy(false);
    if (ok) setName("");
  };

  return (
    <>
      {!embedded && <div className={SECTION_LABEL}>工作区</div>}
      <div className="px-[10px] pb-1">
        <input
          className="w-full min-w-0 bg-transparent border border-border rounded-md px-[9px] py-[6px] text-xs placeholder:text-muted-foreground/70 focus:outline-none focus:border-ring transition-colors duration-150"
          placeholder="工作区名称，回车建群"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void submitCreate(); }}
        />
      </div>
      {error && <p className="px-[10px] pb-1 text-xs text-err">{error}</p>}
      {groups.length === 0 ? (
        <p className="px-[10px] text-xs text-muted-foreground">还没有工作区，建一个开始和好友共享连接器。</p>
      ) : (
        <SidebarMenu>
          {groups.map((g) => (
            <SidebarMenuItem key={g.id}>
              <SidebarMenuButton className="h-auto py-[5px]" onClick={() => setOpenId(g.id)}>
                <Boxes className="size-[14px] shrink-0 text-muted-foreground" />
                <span className="flex-1 min-w-0 truncate text-xs">{g.name}</span>
                <span className="text-[10px] text-muted-foreground">{g.members.length} 人</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      )}
    </>
  );
}
