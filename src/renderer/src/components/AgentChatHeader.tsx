// AgentChatHeader —— 一条聊天的头部（#1280，ADR-0297）。
//
// 团队云会话的头部回答的是「我在哪个团队里」（团队名 + 设置 + 导出）。聊天的头部
// 要回答的是另一个问题：**我在跟谁说话**。所以私聊画它的脸、名字、职责，群聊画
// 一摞脸、群名、成员名——与侧栏那一行同一套读法，点进来之后不换主语。
//
// 纯展示组件，**不读 store**：它拿到的每一格都是调用方算好的。这样它在测试里
// 就是一个可以单独渲染的东西，也不会因为多一个 selector 而多一次重渲。

import { Settings2, UserPlus } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar.js";
import { Button } from "@/components/ui/button.js";
import { agentAvatarSrc } from "../lib/agentAvatar.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** 这一页此刻画的是哪一种聊天（#1280）。`agentIds` 已经与现存名册求过交集
    （`groupRows` / `CloudSessionMain`），所以这里每个 id 都查得到名字 */
export interface ChatView {
  kind: "dm" | "group";
  agentIds: string[];
  /** 私聊 = 那只智能体的名字；群聊 = 群名（没起名时是成员名拼起来的） */
  title: string;
}

/** 群头像最多叠几张。头部比侧栏宽，但名字仍是这一行的主语 */
const STACK_MAX = 3;

export function AgentChatHeader({
  ws,
  chat,
  onPullAgent,
  onAddAgent,
  onSettings,
  voiceSlot,
}: {
  ws: WorkspaceSnapshot;
  chat: ChatView;
  /** 私聊：「拉别的智能体，和它一起另建一个群」。**A4 才接线**，缺席不画 */
  onPullAgent?: () => void;
  /** 群聊：「添加智能体」。**A4 才接线**，缺席不画 */
  onAddAgent?: () => void;
  /** ⚙。私聊开这只智能体的设置，群聊开这个群的 —— 由调用方决定接哪一个 */
  onSettings?: () => void;
  /** 语音那颗钮（#1163）。整块由调用方递进来：判据（没订阅 / 网关不供语音不画）
      与弹层都留在 CloudSessionPage，这一层只管摆在哪儿 */
  voiceSlot?: React.ReactNode;
}) {
  const names = chat.agentIds.map((id) => ws.agents.find((a) => a.agentId === id)?.name ?? id);
  const dm = chat.kind === "dm";
  // 私聊的第二行是它的职责；群聊的第二行是成员名。查不到职责（还没填）就不画，
  // 不拿一句占位话顶上——那一行空着比写「暂无描述」诚实
  const subtitle = dm
    ? ws.agents.find((a) => a.agentId === chat.agentIds[0])?.description ?? ""
    : names.join(" · ");

  return (
    <div className="flex shrink-0 items-center gap-2.5 border-b border-border/60 px-4 py-2">
      <span className="shrink-0 flex items-center">
        {dm ? (
          <Avatar className="size-[30px] rounded-[7px]">
            <AvatarImage src={agentAvatarSrc(ws, chat.agentIds[0] ?? "")} alt="" className="[image-rendering:pixelated]" />
            <AvatarFallback className="rounded-[7px] text-[11px]">{chat.title.slice(0, 1)}</AvatarFallback>
          </Avatar>
        ) : (
          chat.agentIds.slice(0, STACK_MAX).map((id, i) => (
            <Avatar key={id} className="size-[26px] -ml-[7px] first:ml-0 rounded-[6px] ring-[1.5px] ring-background">
              <AvatarImage src={agentAvatarSrc(ws, id)} alt="" className="[image-rendering:pixelated]" />
              <AvatarFallback className="rounded-[6px] text-[10px]">{(names[i] ?? id).slice(0, 1)}</AvatarFallback>
            </Avatar>
          ))
        )}
      </span>
      <span className="min-w-0 flex-1 flex flex-col gap-[1px]">
        <span className="min-w-0 truncate text-[13.5px] font-semibold">{chat.title}</span>
        {subtitle !== "" && (
          <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">{subtitle}</span>
        )}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {voiceSlot}
        {dm && onPullAgent && (
          <Button
            variant="outline"
            size="xs"
            onClick={onPullAgent}
            title="拉别的智能体，和它一起另建一个群"
            aria-label="拉别的智能体"
          >
            <UserPlus className="size-[13px]" aria-hidden />
          </Button>
        )}
        {!dm && onAddAgent && (
          <Button variant="outline" size="xs" onClick={onAddAgent} title="往这个群里添加智能体">
            <UserPlus className="size-[13px]" aria-hidden />
            添加智能体
          </Button>
        )}
        {onSettings && (
          <Button
            variant="outline"
            size="xs"
            onClick={onSettings}
            title={dm ? `${chat.title} 的设置` : "群设置"}
            aria-label="设置"
          >
            <Settings2 className="size-[13px]" aria-hidden />
          </Button>
        )}
      </div>
    </div>
  );
}
