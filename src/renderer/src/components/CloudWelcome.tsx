// CloudWelcome —— 在团队里开新会话的开局卡（issue #919）。
//
// 维护者要的是「团队创建会话方式应该和用户本地会话一致」。本地那条路是：侧栏
// 工程组头一颗 ＋ → 主区一张 composer → 写完第一句、发出去才真的建会话。这一屏
// 是它在云那边的对应物，位置（主区正中）、外壳（ComposerBar）、回车即发、
// 空文本发不出去——都逐处对齐 App.tsx 的 Welcome。
//
// **少掉的控件不是漏做**：文件夹、型号、thinking 挡位在云会话里都不是「这一条
// 会话」的属性，而是**团队**的属性（仓库在 config 帧里由 owner 配，模型 key
// 跟着团队走见 ADR-0202，云会话本来就没有型号选单）。把它们摆上来会得到三个
// 点了不生效的控件——那比少三个控件糟得多。**免审那颗开关不在这一屏，但它存在**
// （#1029，ADR-0243）：它住在真正开起来的那条会话的输入框那一行。这里不摆，
// 是因为此刻还没有会话、也还没有任何东西在等审批——它要解决的问题（一张卡挡着
// 群聊）在开局卡上还不存在。
//
// 发出去之后这句话不会立刻上路：主进程的 say() 要求连接已 ready
// （cloudSessionClient 的 requireReady），而建会话 + 进房结束时 runtime 的
// welcome 还在路上。所以 store 把它排进 cloudPendingFirstMessage，由主区那块
// 在 ready 那一刻补发（见 store.ts 该字段的注释）。

import { useRef, useState } from "react";
import { ComposerBar, ComposerSend } from "@/components/elements/composer.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Button } from "@/components/ui/button.js";
import { useChat } from "../store.js";
import { AgentFace } from "./AgentFace.js";
import { agentFaceSlot } from "../lib/agentAvatar.js";
import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";

/** 三枚提示 chip（#1280 A5）。点了**只把那句话填进输入框、不发送**——人多半想改两个字，
    而「点一下就发出去」会让一颗写着「客服」的钮变成一个不可撤销的动作。
    它们是给第一次的人的：已经聊过管理员的人点「新智能体」会落进那条线，看不到这一屏 */
const NEW_AGENT_CHIPS: readonly { label: string; text: string }[] = [
  { label: "管运营的", text: "帮我建一只管运营的，盯店铺数据、每周出周报" },
  { label: "客服", text: "帮我建一只客服，回评价、整理常见问题" },
  { label: "写代码的", text: "帮我建一只写代码的，改 bug、提 PR" },
];

export function CloudWelcome({ workspaceId }: { workspaceId: string }) {
  const ws = useChat((s) => s.workspaceGroups.find((g) => g.id === workspaceId) ?? null);
  const name = ws?.name ?? "团队";
  const error = useChat((s) => s.workspaceGroupsError);
  // 这张卡是不是一条**聊天**的开局卡（#1280）。私聊那一支换一整套文案：
  // 主语从「这个团队」变成「这一只」
  const draftChat = useChat((s) => s.cloudDraftChat);
  const dmAgent =
    draftChat?.kind === "dm" && ws !== null
      ? ws.agents.find((a) => a.agentId === draftChat.agentId) ?? null
      : null;
  const createFromDraft = useChat((s) => s.createCloudSessionFromDraft);
  const cancel = useChat((s) => s.cancelCloudDraft);
  const openNewAgentForm = useChat((s) => s.openNewAgentForm);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const trimmed = text.trim();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  // 管理员的私聊 = 「新智能体」那颗钮的落点（#1280 A5）：这一屏换一整套文案，
  // 主语从「跟这一只聊」变成「建一只新的」
  const isAdminDraft = dmAgent !== null && dmAgent.agentId === ADMIN_AGENT_ID;
  // 判据写成「除了管理员一只都没有」而不是 `agents.length <= 1`：后者在名册里
  // 只有一只**别的**智能体时会说错话，而那句话是给第一次的人看的
  const onlyAdmin = ws !== null && ws.agents.every((a) => a.agentId === ADMIN_AGENT_ID);

  const launch = async (): Promise<void> => {
    if (!trimmed || busy) return;
    setBusy(true);
    await createFromDraft(workspaceId, trimmed);
    // 不 setBusy(false)：成功的话这个组件已经被主区换掉了；失败的话 store 把
    // cloudDraftWorkspaceId 清了、这一屏同样不在了，错误落在 workspaceGroupsError
    // 上由别处显示。留着 busy 只是防同一次点击里的重入
  };

  return (
    <div className="relative flex-1 min-w-0 h-full flex flex-col items-center justify-center gap-4">
      <div className="flex w-[min(640px,90%)] flex-col items-center gap-1">
        {dmAgent !== null ? (
          <>
            {/* 56px：比侧栏那一行的 30px 大一圈——这一屏只有它一个主语 */}
            <AgentFace slot={agentFaceSlot(ws!, dmAgent.agentId)} size={56} className="rounded-[12px] mb-1" />
            {isAdminDraft ? (
              <>
                <p className="text-[19px] font-[600] tracking-[-0.01em]">
                  {onlyAdmin ? "先建你的第一只智能体" : "跟管理员说一句，建一只新的"}
                </p>
                {/* 说清这条路到底会发生什么：不是填一张表，是说一句话然后它替你写好 */}
                <p className="text-[12px] text-muted-foreground text-center">
                  说清它管哪一块就行。管理员会问一句要用哪些连接器，然后直接建好，名字、职责、提示词都替你写了。不满意，点它头像旁的齿轮随时改。
                </p>
              </>
            ) : (
              <>
                <p className="text-[19px] font-[600] tracking-[-0.01em]">{dmAgent.name}</p>
                {/* 两件事说在开始之前：**什么都还没建**（点别处走开就是取消），
                    以及这条线是永久的（以后回来接着聊，不用找「那次的会话」） */}
                <p className="text-[12px] text-muted-foreground text-center">
                  {dmAgent.description === "" ? "" : `${dmAgent.description}。`}还没聊过，说第一句话就开始了。以后一直是这一条，回来接着聊。
                </p>
              </>
            )}
          </>
        ) : (
          <>
            <p className="text-[19px] font-[600] tracking-[-0.01em]">在「{name}」里开一条会话</p>
            {/* 云会话和本地会话最要紧的那点不同，说在开始之前：它不在这台机器上跑 */}
            <p className="text-[12px] text-muted-foreground">
              跑在云端，你关掉 app 它也接着跑；团队里的人都看得见，也都能插话。
            </p>
          </>
        )}
      </div>
      <ComposerBar className="focus-within:border-border dark:border-muted-foreground/15 dark:focus-within:border-muted-foreground/30 w-[min(640px,90%)] text-left transition-colors duration-[120ms]">
        <Textarea
          className="border-none shadow-none resize-none bg-transparent dark:bg-transparent text-foreground text-sm leading-[1.45] min-h-[52px] max-h-[200px] px-3 py-2 focus-visible:ring-0 placeholder:text-foreground/35"
          autoFocus
          rows={2}
          ref={boxRef}
          placeholder={
            isAdminDraft
              ? "比如：帮我建一只管运营的，盯店铺数据、每周出周报"
              : dmAgent !== null
                ? `跟${dmAgent.name}说点什么`
                : "要它做什么？不 @ 谁的话，谁的活谁接。回车发送"
          }
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void launch();
            }
          }}
        />
        <div className="flex items-center gap-2">
          {/* 出口：开局卡不是死胡同。本地那一屏不需要这颗（侧栏永远在旁边、
              随便点一条会话就走了），这一屏也一样能那么走——但这里是「我刚点了
              ＋，反悔」的最短路径，一颗字钮不占地方。
              **聊天里没有这颗**（#1280）：点花名册上别的一只就走了，而「取消」
              暗示这里有个待办要收拾——什么都还没建，没什么可取消的 */}
          {draftChat === null && (
            <Button variant="ghost" size="xs" className="text-muted-foreground" onClick={cancel}>
              取消
            </Button>
          )}
          <span className="flex-1" />
          <ComposerSend
            streaming={false}
            idle={!trimmed || busy}
            disabled={!trimmed || busy}
            className="shrink-0 disabled:pointer-events-none"
            title={trimmed ? "开始会话" : "先写一句话"}
            aria-label="开始会话"
            onClick={() => void launch()}
          />
        </div>
      </ComposerBar>
      {error && <p className="w-[min(640px,90%)] text-[12px] text-err break-words">{error}</p>}
      {isAdminDraft && (
        <div className="flex w-[min(640px,90%)] flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            {NEW_AGENT_CHIPS.map((c) => (
              <Button
                key={c.label}
                variant="outline"
                size="xs"
                className="rounded-full font-normal text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setText(c.text);
                  // 焦点还给输入框：这颗钮的活是**起个头**，人下一步就是接着改那句话。
                  // 不还回去的话他得再点一次输入框才打得了字
                  boxRef.current?.focus();
                }}
              >
                {c.label}
              </Button>
            ))}
          </div>
          {/* 第二条路，不是第二套：两条都落在 AgentEditorScreen 那张表单上。
              压成一行小字是因为主路是上面那句话——真正会用表单的人自己找得到 */}
          <Button
            variant="ghost"
            size="xs"
            className="h-auto p-0 text-[11.5px] text-muted-foreground underline underline-offset-[3px] hover:bg-transparent hover:text-foreground"
            onClick={openNewAgentForm}
          >
            不想聊，直接填表
          </Button>
        </div>
      )}
    </div>
  );
}
