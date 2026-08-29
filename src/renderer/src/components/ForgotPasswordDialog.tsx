// ForgotPasswordDialog — 忘记密码：填邮箱 → 收验证码 → 填回来（issue #741）。
//
// ## 为什么是验证码，不是只发一条链接
//
// 链接那条路要**跳出这个 app**：默认浏览器打开落地页、系统再问一句「要打开 Mr Otto
// 吗」、中间可能还隔着一次冷启动。每一跳都是一个人会走丢的地方，而这一切只为了传回
// 一个六位数。验证码把整段流程留在窗口里。
//
// 链接那条路**没有拆掉** —— 同一封邮件里两样都有，谁先到算谁的（点了链接照样回到
// 登录态，SetPasswordDialog 一样接手）。
//
// ## 验过之后这张弹窗就没了
//
// recovery OTP 换到的是一个**真 session**：验证成功那一刻人已经登录了，这棵树连同
// 这张弹窗一起卸载。所以第三步「设新密码」不在这里 —— 它在 `SetPasswordDialog`，
// 由 `resetPassword` 落下的那笔 pending 记号掀开。把三步硬塞进一张弹窗的话，它得
// 跨过闸门活着，那意味着两个挂载点 + 一份搬进 store 的状态。
//
// **但闸门不跟着抬**（`atGate`，issue #744）：第一版让它抬了，结果是整个 app 在一个
// 还没设完密码的人背后铺开，而「以后再说」等于让旧密码原封不动的他就这么进去。
// 现在按住闸门，那张弹窗压在登录屏上，设完（或明确跳过）才放行。
//
// 「查无此人也不报错」那条规矩由主进程守着（AccountManager.resetPassword），
// 所以这里发完一律进第二步 —— 界面上看不出这个邮箱注册过没有。

import { useEffect, useState } from "react";

import { useChat } from "../store.js";
import { localEmailProblem } from "../lib/authError.js";
import {
  OTP_LENGTH,
  RESEND_COOLDOWN_S,
  canSubmitOtp,
  normalizeOtp,
  resendLabel,
  type ForgotStep,
} from "../lib/forgotPassword.js";
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

export function ForgotPasswordDialog({
  initialEmail,
  atGate = false,
  onClose,
}: {
  /** 登录表单里已经填了的那个邮箱。人已经在那一格上打过字了,不该让他再打一遍 */
  initialEmail: string;
  /** 这次重置是在进门闸上发起的。它在**发信那一刻**就落进记号里（而不是验证时），
      因为点邮件链接那条路要经过浏览器 —— 内存里的标记跨不过那次往返。
      收尾时闸门按住不放，让人在门外把新密码设完（issue #744，见 `lib/identity.ts`） */
  atGate?: boolean;
  onClose: () => void;
}) {
  const resetPassword = useChat((s) => s.resetPassword);
  const verifyRecoveryOtp = useChat((s) => s.verifyRecoveryOtp);
  const setError = useChat((s) => s.setError);

  const [step, setStep] = useState<ForgotStep>("email");
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  /** 重发冷却剩几秒。0 = 解冻 */
  const [cooldown, setCooldown] = useState(0);

  // 一秒一跳的倒数。用 setTimeout 链而不是 setInterval —— 组件在验证成功那一刻会被
  // 整棵卸载,少一个需要记得清掉的常驻定时器
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** 发（或重发）一封重置邮件。本地预检与注册那条路同源,报错落右下角同一张卡 */
  const send = async (): Promise<void> => {
    const addr = email.trim();
    const bad = localEmailProblem(addr);
    if (bad) {
      setError(bad);
      return;
    }
    setBusy(true);
    const ok = await resetPassword(addr, atGate);
    setBusy(false);
    if (!ok) return;
    setStep("code");
    setCooldown(RESEND_COOLDOWN_S);
  };

  const verify = async (): Promise<void> => {
    setBusy(true);
    await verifyRecoveryOtp(email.trim(), normalizeOtp(code));
    setBusy(false);
    // 验过了也不用做别的:登录态一变,这棵树整个卸载(闸门那条路上,
    // 换上来的是同一位置的「设一个新密码」)
  };

  const onEmailStep = step === "email";
  const submit = (): void => void (onEmailStep ? send() : verify());
  const canGo = onEmailStep ? !busy && email.trim() !== "" : canSubmitOtp(code, busy);

  return (
    // 只受控:出口是「取消」或验证成功。Esc / 点遮罩关掉的话,一个正在收信的人
    // 手一抖就得从头再来
    <AlertDialog open>
      <AlertDialogContent size="sm" className="gap-[16px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{onEmailStep ? "找回密码" : "填验证码"}</AlertDialogTitle>
          <AlertDialogDescription>
            {onEmailStep ? (
              "填注册时用的邮箱，我们发一个验证码过去。"
            ) : (
              <>
                验证码发到 <span className="font-medium text-foreground">{email.trim()}</span>{" "}
                了，填回来就能设新密码。邮件里那条链接点了也算。
              </>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-[8px]">
          {onEmailStep ? (
            <Input
              type="email"
              placeholder="邮箱"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canGo) submit();
              }}
            />
          ) : (
            <>
              <Input
                // 数字键盘 + one-time-code:iOS/macOS 会把邮件里那串数字直接递上来,
                // 用户连复制都不用
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={OTP_LENGTH}
                placeholder={"0".repeat(OTP_LENGTH)}
                className="text-center font-mono text-[18px] tracking-[0.4em]"
                value={code}
                // 粘进来的整句在这里就被擦干净,而不是等到提交那一刻报「码不对」
                onChange={(e) => setCode(normalizeOtp(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canGo) submit();
                }}
              />
              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-[12px] text-muted-foreground"
                  disabled={cooldown > 0 || busy}
                  onClick={() => void send()}
                >
                  {resendLabel(cooldown)}
                </Button>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-[12px] text-muted-foreground"
                  onClick={() => {
                    setStep("email");
                    setCode("");
                  }}
                >
                  换个邮箱
                </Button>
              </div>
            </>
          )}
        </div>

        <AlertDialogFooter>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <AlertDialogAction asChild>
            {/* asChild 借本仓的 Button 样式,但它默认点了就关弹窗 ——
                这里两步都还要留在弹窗里,所以 preventDefault */}
            <Button
              disabled={!canGo}
              onClick={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              {busy ? "稍等…" : onEmailStep ? "发送验证码" : "提交"}
            </Button>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
