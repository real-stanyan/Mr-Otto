// ProfileSetupDialog — 新用户第一次登录后的引导弹窗(issue #95)。
//
// 弹窗只弹一次:它由 profiles.onboarded_at 决定,而不是本地标记 —— 换台机器、
// 重装、清缓存都不该让它回来。"以后再说"和"完成"都盖章,区别只是有没有一起写资料。
//
// 关不掉的模态是一种粗鲁:这里允许 Esc / 点外面 / 右上角 × 关掉,
// 但那些路径不盖章 —— 用户只是现在不想弄,下次登录还该被问一次(Agency,
// 不是"必须填完才能用"的收费站)。

import { useState } from "react";
import { useChat } from "../store.js";
import { displayIdentity } from "../lib/identity.js";
import { ProfileEditor, type ProfileDraft } from "./ProfileEditor.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog.js";

/**
 * 外壳:只管开合。内容拆成下面一层是为了两件事同时成立 ——
 *   ① 草稿的初值在**打开那一刻**才取。这个组件常驻在 App 里,写成一层的话
 *      useState 会在 app 启动时(profile 还是 null)就把草稿定成空的,
 *      等到真弹出来时名字框里是空白而不是当前的名字。
 *   ② 关闭动画还能播。radix 的 Presence 会等动画跑完再卸载 content,
 *      但如果我们自己在 open=false 时就把整个 Dialog 拆了,它没机会播。
 */
export function ProfileSetupDialog() {
  const open = useChat((s) => s.profileSetupOpen);
  const setOpen = useChat((s) => s.setProfileSetupOpen);

  return (
    <Dialog
      open={open}
      // Esc / 点遮罩 / × —— 都算"现在不想弄",不盖章,下次登录再问
      onOpenChange={(next) => { if (!next) setOpen(false); }}
    >
      <DialogContent className="sm:max-w-[420px]">
        <ProfileSetupBody />
      </DialogContent>
    </Dialog>
  );
}

function ProfileSetupBody() {
  const account = useChat((s) => s.account);
  const profile = useChat((s) => s.myProfile);
  const save = useChat((s) => s.saveMyProfile);
  const setOpen = useChat((s) => s.setProfileSetupOpen);

  const identity = displayIdentity(account, profile);
  // 草稿只在挂载时取一次初值 —— 打字过程中 profile 若被刷新(轮询/换号)不该把
  // 用户正在输入的内容冲掉。弹出时才挂载,所以每次弹出都是新鲜的初值
  const [draft, setDraft] = useState<ProfileDraft>({
    name: identity.name,
    avatarUrl: identity.avatarUrl,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    // onboarded 和资料一起写:两次请求会出现"名字存了、章没盖上"的中间态,
    // 那意味着下次登录还会被问一次,而用户明明已经填过了
    const message = await save({ name: draft.name, avatarUrl: draft.avatarUrl, onboarded: true });
    setBusy(false);
    if (message) setError(message);
    else setOpen(false);
  };

  const later = async () => {
    setBusy(true);
    // 只盖章不写资料:用户没表达要改什么,别把 provider 给的值再原样写回去一遍
    await save({ onboarded: true });
    setBusy(false);
    setOpen(false);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>先给自己起个名字</DialogTitle>
        <DialogDescription>
          好友列表和聊天里显示的都是这里的名字和头像。随时能在「账号」里改。
        </DialogDescription>
      </DialogHeader>

      <ProfileEditor
        draft={draft}
        onChange={setDraft}
        initial={identity.initial}
        error={error}
        busy={busy}
        autoFocus
      />

      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={() => void later()}>
          以后再说
        </Button>
        <Button disabled={busy || draft.name.trim() === ""} onClick={() => void finish()}>
          {busy ? "保存中…" : "就这样"}
        </Button>
      </DialogFooter>
    </>
  );
}
