// SetPasswordDialog — 点完重置链接回来之后，设一个新密码（issue #739）。
//
// 为什么这一步不能省：重置链接换到的是一个 **session**，人确实进来了 —— 但旧密码
// 一个字都没变。少了这一步，用户下次换台设备照样进不去，而他会以为自己已经重置过了。
//
// 什么时候弹：`store.setPasswordOpen`。那个标记落在 localStorage 而不是内存 ——
// 用户是在**浏览器**里点的链接，回到 app 中间很可能隔着一次冷启动（见 store 的
// `RESET_PENDING_KEY`）。
//
// 这张弹窗挂在 App 里而不是进门闸里：走到这一步的人**已经是登录态**，闸门早抬起来了。

import { useState } from "react";

import { useChat } from "../store.js";
import { MIN_PASSWORD } from "../lib/signInForm.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";

export function SetPasswordDialog() {
  const open = useChat((s) => s.setPasswordOpen);
  const setOpen = useChat((s) => s.setSetPasswordOpen);
  const updatePassword = useChat((s) => s.updatePassword);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) return null;

  // 与注册那张表单同一套规矩：够长 + 两次一致，且**空着不念**
  const mismatch = confirm !== "" && password !== confirm ? "两次输入不一样" : null;
  const canSave = !busy && password.length >= MIN_PASSWORD && password === confirm;

  const save = async (): Promise<void> => {
    setBusy(true);
    const ok = await updatePassword(password);
    setBusy(false);
    // 失败的话 store.error 已经写好了，右下角那张卡会说话；弹窗留着让他再试
    if (ok) {
      setPassword("");
      setConfirm("");
    }
  };

  return (
    <AlertDialog open>
      <AlertDialogContent size="sm" className="gap-[16px]">
        <AlertDialogHeader>
          <AlertDialogTitle>设一个新密码</AlertDialogTitle>
          <AlertDialogDescription>
            你已经进来了，但旧密码还没变 —— 现在设一个，下次在别的设备上才用得上。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-[8px]">
          <Input
            type="password"
            placeholder={`新密码（至少 ${MIN_PASSWORD} 位）`}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Input
            type="password"
            placeholder="再输一遍"
            autoComplete="new-password"
            aria-invalid={mismatch !== null}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <p className="px-[2px] text-[12px] text-err">{mismatch}</p>}
        </div>
        <AlertDialogFooter>
          {/* 可以跳过：他已经进来了，逼着设密码只是又一道收费站。
              跳过就把那笔记号抹掉 —— 下次登录不该再被问一遍 */}
          <Button variant="ghost" onClick={() => setOpen(false)}>
            以后再说
          </Button>
          <AlertDialogAction asChild>
            <Button
              disabled={!canSave}
              onClick={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              {busy ? "保存中…" : "保存"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
