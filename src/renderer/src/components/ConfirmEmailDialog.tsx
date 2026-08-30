// ConfirmEmailDialog — 注册完、等用户去邮箱点确认链接的那张弹窗（issue #737）。
//
// 原来这一步只在卡里冒一行小字，用户不知道要等什么、等到什么时候算完。现在它是一张
// AlertDialog：写清楚发到哪个邮箱、要做什么，**并且我们自己盯着**——确认成功就自己
// 关掉、直接进 app，不用他回来按那颗按钮。
//
// ## 怎么知道他确认完了
//
// **不能只靠深链回跳。** 确认链接现在确实指着落地页（`signUp` 传了
// `emailRedirectTo`，见 `main/account.ts` 与 issue #743），但那条路要经过默认浏览器、
// 系统那句「要打开 Mr Otto 吗」，中间还可能隔着一次冷启动 —— 每一跳都可能不回来。
//
// 可靠的判据是**重试登录**：邮箱没确认时 GoTrue 一律回 `Email not confirmed`，确认
// 之后同一把邮箱密码立刻就能换到 session。所以这里的轮询既是检测、又顺手把登录做了
// —— 成功那一刻 `onAccountChanged` 推来登录态，进门闸自己抬起来，这张弹窗跟着卸载。
//
// 轮询走 `signInWithPassword(..., silent)`：轮询期间每隔几秒失败一次是**预期**，
// 不能写进 `store.error`，否则右下角那张报错卡会一直弹（见 store 里那个参数的注释）。
//
// 密码留在内存里（组件的 props），不落盘、不进日志——它只活到这张弹窗关掉。

import { useEffect, useState } from "react";

import { useChat } from "../store.js";
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

/**
 * 第 n 次探测该等多久（n 从 0 起）。**前快后慢**，不是固定间隔。
 *
 * 固定 4 秒会撞 GoTrue 的限流：`/token` 默认 30 次 / 5 分钟 / IP，4 秒一次是 75 次，
 * 于是「等确认」自己把账号打进限流，用户看到的是一句「试得太频繁了」—— 一个纯粹
 * 由我们自己制造的故障。
 *
 * 前 6 次每 5 秒（人通常就在这半分钟里点完邮件，这一段要跟得上），之后退到 15 秒。
 * 任意 5 分钟窗口里最多 6 + 20 = 26 次，压在 30 以下。
 */
export function pollDelayMs(attempt: number): number {
  return attempt < 6 ? 5000 : 15000;
}

export function ConfirmEmailDialog({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  /** 用户主动关掉（「稍后再说」）。确认成功那条路不走这里 —— 登录态一变，
      整个进门闸连同这张弹窗一起卸载 */
  onClose: () => void;
}) {
  const signInWithPassword = useChat((s) => s.signInWithPassword);
  const [checking, setChecking] = useState(false);
  /** 手动按过「我已确认」但还没确认成功。只用来说一句「还没生效」，
      不阻止他再按 —— 邮件到得慢是常事 */
  const [notYet, setNotYet] = useState(false);

  // 自动探测。用「一次一约」的 setTimeout 而不是 setInterval —— 间隔是变的，
  // 而且上一轮还在飞的时候不该叠下一轮（网络慢时 setInterval 会堆积请求，
  // 正好把限流撞得更快）。stop 挡住组件卸载后还 setState
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    const tick = async (): Promise<void> => {
      if (stop) return;
      await signInWithPassword(email, password, true);
      // 成功了也不用做别的:onAccountChanged 会把登录态推来,这棵树整个卸载
      if (stop) return;
      timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    };
    timer = setTimeout(() => void tick(), pollDelayMs(attempt++));
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [email, password, signInWithPassword]);

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    setNotYet(false);
    const ok = await signInWithPassword(email, password, true);
    setChecking(false);
    if (!ok) setNotYet(true);
  };

  return (
    // 只受控、不给关闭手势：这张弹窗有两个出口（确认成功自动走 / 点「稍后再说」），
    // Esc 和点遮罩关掉的话，用户会以为注册失败了
    <AlertDialog open>
      <AlertDialogContent size="sm" className="gap-[16px]">
        <AlertDialogHeader>
          <AlertDialogTitle>去邮箱点一下确认链接</AlertDialogTitle>
          <AlertDialogDescription>
            确认信已经发给 <span className="font-medium text-foreground">{email}</span>
            。点开里面的链接，这里会自己继续，不用回来按什么。
          </AlertDialogDescription>
        </AlertDialogHeader>
        <p className="text-center text-[13px] text-muted-foreground">
          {notYet ? "还没生效——邮件可能慢了一点，也看看垃圾箱。" : "正在等你确认…"}
        </p>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            稍后再说
          </Button>
          <AlertDialogAction asChild>
            {/* 「我已确认」= 立刻探一次，不用等下一个轮询周期。
                asChild 是为了拿本仓的 Button 样式，但它默认会关掉弹窗 ——
                所以点击里 preventDefault，成没成由登录态说了算 */}
            <Button
              disabled={checking}
              onClick={(e) => {
                e.preventDefault();
                void checkNow();
              }}
            >
              {checking ? "查一下…" : "我已确认"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
