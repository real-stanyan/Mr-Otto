// NewWorkspaceDialog —— 侧栏「＋ 新工作区」那颗按钮的落点（issue #917，ADR-0217）。
//
// 弹窗而不是换页（与 WorkspacePage 的「换页不是弹窗」相反，理由也相反）：这里
// 只有一个字段、一次性、做完就走，是 ADR-0185 说的那种「模态任务」；换页会把
// 用户从会话列表里整个搬走，为了填一个名字。压暗背景 + 居中卡片是这类任务的
// 标准形态（Apple HIG：dim to focus）。
//
// 四个状态各有各的出口，一个都不能是死胡同（wayfinding：任何一屏都要能出去）：
// · allowed —— 填名字，回车即建
// · no_subscription —— 说清为什么要订阅（规则二：额度记在创建者头上），给「去订阅」
// · signed_out —— 给「去登录」
// · unknown —— 还没问到 billing（冷启动/断网）。**不说「你没有订阅」**，那句话
//   可能是假的，见 workspaceAccess.ts 的注释；这里打开时顺手补一次 loadBilling
//
// 「建成功了但列表没刷出来」单列一态（issue #843 症状 1）：store 的
// createWorkspaceGroup 成功后自己 refresh 一次，refresh 失败落的是**同一个**
// workspaceGroupsError——照直关掉弹窗，用户看到的就是「一条错误 + 空列表」，与
// 「没建成」一模一样，而这两件事该做的动作正好相反（别重建 / 重建）。真机上因此
// 多建了一个同名工作区。#843 的另外两条（一个群坏掉整份列表全挂、数据库原文直出）
// 不在这条 issue 的范围里，留在 #843。

import { useEffect, useState } from "react";
import { Boxes } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useChat } from "../store.js";
import { workspaceAccess } from "../lib/workspaceAccess.js";

export function NewWorkspaceDialog({
  open,
  onOpenChange,
  onCreated,
  onGoBilling,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 建成功后调一次：调用方负责把侧栏切到能看见它的那一栏（空间一致性——
      从这颗按钮生出来的东西，得在这颗按钮下面出现） */
  onCreated: () => void;
  /** 去账号页（订阅区在那儿，issue #909）。未登录时同一个落点：那一页上就有登录卡 */
  onGoBilling: () => void;
}) {
  const signedIn = useChat((s) => s.account.signedIn);
  const billing = useChat((s) => s.billing);
  const loadBilling = useChat((s) => s.loadBilling);
  const createGroup = useChat((s) => s.createWorkspaceGroup);
  const error = useChat((s) => s.workspaceGroupsError);

  const access = workspaceAccess({ signedIn, billing });

  // 打开时补一次订阅快照：没查过就点开这扇窗的概率不低（冷启动后第一件事），
  // 而 unknown 这一态本身没有内容可给，能自己变成结论就别让用户干等
  useEffect(() => {
    if (open && billing === null && signedIn) void loadBilling(false);
  }, [open, billing, signedIn, loadBilling]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* key 挂在 open 上：每次打开都是一份全新的草稿/状态，
          不会把上次那半个名字或上次那条错误带进来 */}
      <DialogContent className="sm:max-w-md" key={open ? "open" : "closed"}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Boxes className="size-4 text-muted-foreground" aria-hidden />
            新建工作区
          </DialogTitle>
          <DialogDescription className="text-[12px] leading-relaxed">
            工作区是和好友共用的一块地方：共享连接器、共享会话，会话跑在云端，
            你不开机也在跑。
          </DialogDescription>
        </DialogHeader>
        {access === "allowed" || access === "unknown" ? (
          <NewWorkspaceForm
            checking={access === "unknown"}
            error={error}
            onCancel={() => onOpenChange(false)}
            onCreate={createGroup}
            onDone={() => {
              onOpenChange(false);
              onCreated();
            }}
          />
        ) : (
          <>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {access === "signed_out"
                ? "工作区跟着账号走——先登录才能建。"
                : // 规则一，连同它的理由一起说：光说「要订阅」听起来像收过路费，
                  // 说清「谁付这笔钱」才解释得通为什么门槛在创建者这一侧
                  "建工作区要一份订阅。工作区里的每一次模型调用都记在创建者的额度上（你拉进来的人跑的那些也算），所以得先有额度可记。"}
            </p>
            <DialogFooter>
              <Button type="button" variant="ghost" className="press-scale" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                type="button"
                className="press-scale"
                onClick={() => {
                  onOpenChange(false);
                  onGoBilling();
                }}
              >
                {access === "signed_out" ? "去登录" : "去订阅"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 表单单拆一层：草稿 state 要在弹窗每次打开时从空起头，写在上一层的话
    open 从 false 变 true 时组件已经挂着，useState 的初值吃不到那一次
    （同 App.tsx 的 RenameForm，那儿是同一个坑的另一种形状）。 */
function NewWorkspaceForm({
  checking,
  error,
  onCancel,
  onCreate,
  onDone,
}: {
  checking: boolean;
  error: string | null;
  onCancel: () => void;
  onCreate: (name: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  // 这一轮里按过「创建」没有。workspaceGroupsError 是全局的、上一次失败留下的那条
  // 还在（侧栏那一节也在渲染它），不按这个门槛的话，重新打开弹窗会当头一条与本次
  // 操作无关的红字——读起来像「还没填就已经错了」
  const [attempted, setAttempted] = useState(false);
  // 建成功了，但紧接着的那次 refresh 挂了（#843 症状 1）。这一态既不是成功
  // 也不是失败，得单独说——尤其得说出「别再建一次」
  const [staleAfterCreate, setStaleAfterCreate] = useState(false);
  const trimmed = name.trim();

  const submit = async (): Promise<void> => {
    if (!trimmed || busy || checking) return;
    setAttempted(true);
    setBusy(true);
    const ok = await onCreate(trimmed);
    setBusy(false);
    if (!ok) return; // 失败原因已落 workspaceGroupsError，下面那行渲染它
    // ok 之后 error 还在 = create 成功、refresh 失败（两者共用同一个错误槽位）
    if (useChat.getState().workspaceGroupsError) {
      setStaleAfterCreate(true);
      return;
    }
    onDone();
  };

  if (staleAfterCreate) {
    return (
      <>
        <p className="text-[12px] leading-relaxed">
          工作区<span className="font-medium">「{trimmed}」</span>已经建好了，但列表没刷新出来。
          <span className="text-muted-foreground">别再建一次</span>——重开一次或稍后再看，它就在那儿。
        </p>
        {attempted && error && <p className="text-[12px] text-err break-words">{error}</p>}
        <DialogFooter>
          <Button type="button" className="press-scale" onClick={onCancel}>
            知道了
          </Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form
      className="contents"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        autoFocus
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        placeholder="工作区名称"
        aria-label="工作区名称"
      />
      {/* 规则二写在建之前，不写在建之后：这是一句要在掏钱前听见的话 */}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        里面的每一次模型调用都记在<span className="text-foreground">你的</span>订阅额度上，
        包括你拉进来的成员跑的那些。
      </p>
      {attempted && error && <p className="text-[12px] text-err break-words">{error}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" className="press-scale" disabled={busy} onClick={onCancel}>
          取消
        </Button>
        {/* 空名字不给建：一个没有名字的工作区在侧栏里就是一行空白。
            checking 期间也按不动——还不知道有没有订阅，按下去只会拿到一条服务端拒绝 */}
        <Button type="submit" className="press-scale" disabled={!trimmed || busy || checking}>
          {busy ? "创建中…" : checking ? "正在确认订阅…" : "创建"}
        </Button>
      </DialogFooter>
    </form>
  );
}
