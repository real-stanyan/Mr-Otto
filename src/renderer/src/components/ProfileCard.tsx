// ProfileCard — 账号页里那块"我是谁",和首登引导弹窗共用 ProfileEditor。
//
// 保存钮只在改过之后才出现:没改动时它是一颗按了没反应的按钮,常驻只会让人怀疑
// 自己是不是漏了什么。保存成功后短暂出现"已保存",不留常驻状态位 ——
// 反馈要有,但不该在屏幕上住下来。
//
// 名字平时是一行字,点它才变输入框(#1022):改名一辈子一次,而那个框天天占着
// 这一页最上面最重的一块。编辑态在这里拿着而不在 ProfileEditor 里 —— 撤销/保存
// 之后要退回一行字,而只有这里知道"改回去了没有"。
//
// 邮箱与退出登录收进同一行(原来它俩单独占一行漂在卡外):退出登录是这一页最少用、
// 最不该被误点的动作,原来却是唯一带边框的按钮,所以降成幽灵钮。

import { useEffect, useState } from "react";
import { useChat } from "../store.js";
import { displayIdentity } from "../lib/identity.js";
import { ProfileEditor, type ProfileDraft } from "./ProfileEditor.js";
import { Button } from "@/components/ui/button.js";

/** "已保存"在屏幕上停留的时间。够看见,不够碍事 */
const SAVED_HINT_MS = 2000;

export function ProfileCard() {
  const account = useChat((s) => s.account);
  const profile = useChat((s) => s.myProfile);
  const save = useChat((s) => s.saveMyProfile);
  const signOut = useChat((s) => s.signOut);

  const identity = displayIdentity(account, profile);
  const [draft, setDraft] = useState<ProfileDraft>({
    name: identity.name,
    avatarUrl: identity.avatarUrl,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editingName, setEditingName] = useState(false);

  // 资料从主进程回来(冷启动补拉/换号)时对齐草稿。只在"没在编辑"时对齐:
  // 正打着字被一次后台刷新冲掉输入,是最气人的一种 bug
  const serverName = identity.name;
  const serverAvatar = identity.avatarUrl;
  const dirty = draft.name !== serverName || draft.avatarUrl !== serverAvatar;
  useEffect(() => {
    if (!dirty) setDraft({ name: serverName, avatarUrl: serverAvatar });
    // dirty 故意不进依赖:它由 draft 算出来,进了就会在每次输入后把草稿拽回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverName, serverAvatar]);

  useEffect(() => {
    if (!saved) return;
    const t = setTimeout(() => setSaved(false), SAVED_HINT_MS);
    return () => clearTimeout(t);
  }, [saved]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const message = await save({ name: draft.name, avatarUrl: draft.avatarUrl });
    setBusy(false);
    if (message) setError(message);
    else {
      setSaved(true);
      setEditingName(false);
    }
  };

  const undo = () => {
    setDraft({ name: serverName, avatarUrl: serverAvatar });
    setEditingName(false);
  };

  return (
    <div className="flex flex-col gap-3">
      <ProfileEditor
        draft={draft}
        onChange={setDraft}
        initial={identity.initial}
        error={error}
        busy={busy}
        nameEditing={editingName}
        onNameClick={() => setEditingName(true)}
        subline={
          <span className="truncate text-[12px] text-muted-foreground">{identity.email}</span>
        }
        trailing={
          <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => void signOut()}>
            退出登录
          </Button>
        }
        actions={
          <>
            {/* 状态提示和保存钮占同一个位置:它们互斥,分两处放会让这一行忽宽忽窄 */}
            {saved && !dirty && <span className="saved-hint text-xs text-muted-foreground">已保存</span>}
            {dirty && (
              <>
                <Button variant="ghost" size="sm" disabled={busy} onClick={undo}>
                  撤销
                </Button>
                <Button size="sm" disabled={busy || draft.name.trim() === ""} onClick={() => void submit()}>
                  {busy ? "保存中…" : "保存"}
                </Button>
              </>
            )}
          </>
        }
      />
    </div>
  );
}
