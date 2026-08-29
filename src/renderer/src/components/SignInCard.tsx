// SignInCard — 登录/注册那张卡本身（OAuth 在上,分隔线,邮箱密码在下）。
//
// 从 App.tsx 抽出来是因为它现在有**两个**渲染点（ADR-0182）：
//   1. `components/SignInScreen.tsx` —— 进门那道闸，没有登录记录时的整屏
//   2. `App.tsx` 的账号页 —— 有登录记录但此刻没验上（离线 / session 过期）时
//      仍然会落到这里，闸门放行的正是这类人
// 两处必须是同一张卡：登录入口有两套写法，改一处忘一处是迟早的事。

import { useState } from "react";

import { useChat } from "../store.js";
import { HINT } from "../settingsShell.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { cn } from "@/lib/utils.js";

/** Google 官方四色 G(品牌规范配色,path 数据是官方 SVG)。尺寸交给按钮的 [&_svg] 规则 */
function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.29A7.16 7.16 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a11.99 11.99 0 0 0 0 10.76l3.98-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}

/** GitHub mark(官方 octocat 轮廓),currentColor 跟随按钮文字色,暗色主题下自动反白 */
function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
      <path d="M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.8 1.3 3.49 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.66 1.66.25 2.88.12 3.18.77.84 1.23 1.91 1.23 3.22 0 4.61-2.8 5.63-5.48 5.92.43.37.81 1.1.81 2.22l-.01 3.29c0 .32.22.7.83.57A12 12 0 0 0 12 .3Z" />
    </svg>
  );
}

/** 邮箱密码登录/注册表单（登录卡片内,OAuth 按钮下方）。
    登录成功由 onAccountChanged 推账号,表单自己只管两件事:
    注册后"去邮箱点确认链接"的提示,和转圈期间禁点。错误走 store.error 统一显示 */
function EmailPasswordForm() {
  const signInWithPassword = useChat((s) => s.signInWithPassword);
  const signUpWithPassword = useChat((s) => s.signUpWithPassword);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const canSubmit = !busy && email.includes("@") && password.length >= 6;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setNotice(null);
    try {
      if (mode === "sign-in") {
        await signInWithPassword(email, password);
      } else {
        const result = await signUpWithPassword(email, password);
        if (result === "confirm-email") {
          setNotice("确认邮件已发送,点完邮件里的链接后回来登录。");
          setMode("sign-in");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-[8px]"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Input
        type="email"
        placeholder="邮箱"
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <Input
        type="password"
        placeholder={mode === "sign-up" ? "密码（至少 6 位）" : "密码"}
        autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button type="submit" disabled={!canSubmit} className="w-full mt-[2px]">
        {busy ? "…" : mode === "sign-in" ? "用邮箱登录" : "注册"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground"
        onClick={() => {
          setMode(mode === "sign-in" ? "sign-up" : "sign-in");
          setNotice(null);
        }}
      >
        {mode === "sign-in" ? "没有账号？注册" : "已有账号？登录"}
      </Button>
      {notice && <p className={HINT}>{notice}</p>}
    </form>
  );
}

/** 未登录态的登录卡片:OAuth 在上(老用户全走这),分隔线,邮箱密码在下。
    `className` 给进门闸留的口子——同一张卡,铺在动效背景上时要换一层材质 */
export function SignInCard({ className }: { className?: string }) {
  const signIn = useChat((s) => s.signIn);

  return (
    <Card className={cn("w-full max-w-[360px]", className)}>
      <CardHeader>
        <CardTitle>登录 Mr Otto</CardTitle>
        <CardDescription>登录后可在多台设备同步配置（即将上线）</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-[16px]">
        <div className="flex flex-col gap-[8px]">
          <Button variant="outline" className="w-full" onClick={() => void signIn("google")}>
            <GoogleIcon />
            用 Google 登录
          </Button>
          <Button variant="outline" className="w-full" onClick={() => void signIn("github")}>
            <GitHubIcon />
            用 GitHub 登录
          </Button>
        </div>
        {/* 分隔线上嵌一句话:比孤零零一个「或」更说明下半段是什么 */}
        <div className="relative text-center text-xs text-muted-foreground after:absolute after:inset-x-0 after:top-1/2 after:border-t after:border-border">
          <span className="relative z-10 bg-card px-[8px]">或用邮箱</span>
        </div>
        <EmailPasswordForm />
      </CardContent>
    </Card>
  );
}
