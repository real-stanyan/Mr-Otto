// WorkspaceMembersTab —— 工作区设置里的「成员」那一页（#1120 从 WorkspacePage 抽出）。
// 判据、二次确认、owner 才能拉人，一个字没动；改的只有行的样子与那两段解释的位置。

import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { InsetEmpty, InsetGroup, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useChat } from "../store.js";
import { memberRows } from "../lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** 名字首字的圆片。**不是头像**——成员没有内置头像那套坑位（那是 agent 的），
    这里只求「前导槽位对得齐」，所以是一个中性圆片不是一张脸 */
function MemberChip({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-[27px] shrink-0 place-items-center rounded-full bg-foreground/[0.09] text-[12px] text-muted-foreground"
    >
      {[...name.trim()][0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export function WorkspaceMembersTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const kick = useChat((s) => s.kickWorkspaceGroupMember);
  const addMember = useChat((s) => s.addWorkspaceGroupMember);
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const rows = memberRows(ws, selfUid);

  const memberUids = new Set(ws.members.map((m) => m.uid));
  const candidates = friends.filter((f) => !memberUids.has(f.profile.id));

  return (
    <div className="flex flex-col">
      <InsetLabel className="pt-0">成员</InsetLabel>
      <InsetGroup sepInset={51}>
        {rows.map((row) => (
          <InsetRow
            key={row.uid}
            leading={<MemberChip name={row.label} />}
            title={row.label}
            subtitle={row.role === "owner" ? "所有者 · 额度记在 TA 头上" : "成员"}
            trailing={
              row.canKick ? (
                <Button
                  variant="ghost" size="xs" className="text-err"
                  onClick={() => {
                    if (confirm(`把 ${row.label} 移出工作区？TA 借用/贡献的连接器授权会立即失效。`)) {
                      void kick(ws.id, row.uid);
                    }
                  }}
                >
                  移出
                </Button>
              ) : null
            }
          />
        ))}
      </InsetGroup>
      <InsetNote>
        工作区的账<b className="font-medium text-foreground">全记在所有者头上</b>——成员不必各自订阅。
      </InsetNote>

      {ws.ownerUid === selfUid && (
        <>
          <InsetLabel>拉好友加入</InsetLabel>
          <InsetGroup sepInset={51}>
            {candidates.length === 0 ? (
              <InsetEmpty
                title="好友都已经在这里了"
                hint="先在「好友」里加人，再回来把 TA 拉进这个工作区。"
              />
            ) : (
              candidates.map((f) => (
                <InsetRow
                  key={f.profile.id}
                  leading={<MemberChip name={f.profile.name || f.profile.email} />}
                  title={f.profile.name || f.profile.email}
                  onClick={() => void addMember(ws.id, f.profile.id)}
                  trailing={<span className="inline-flex items-center gap-1 text-brand"><UserPlus className="size-[12px]" />加入</span>}
                />
              ))
            )}
          </InsetGroup>
        </>
      )}
    </div>
  );
}
