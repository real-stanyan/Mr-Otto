// SignInCard — 登录/注册那组控件本身。**一张卡**，自上而下三段：
// 邮箱密码 → OAuth → 「没有账号？注册」（结构见 #731，合成一张见 #735）。
//
// **logo 和「Mr Otto」字样不在这里** —— 它们属于进门那一屏（`SignInScreen`），
// 不属于这组控件。因为这个文件有两个渲染点：
//   1. `components/SignInScreen.tsx` —— 进门闸，没有登录记录时的整屏
//   2. `App.tsx` 的账号页 —— 有登录记录但此刻没验上（离线 / session 过期）时
//      仍然会落到这里，闸门放行的正是这类人（ADR-0182）
// 账号页不该顶一张大 logo，而两处的**控件**必须是同一份：登录入口有两套写法，
// 改一处忘一处是迟早的事。
//
// 三段共用一个边框，段与段之间**只靠间距**区分（段间 16px / 段内 8px，2:1）——
// 每段各有一圈边框的话，读到的是三个并列的东西，而它们其实是"登录"这一件事的
// 三条路。顺序上邮箱在前、OAuth 在后是维护者定的（#731）。

import { useState } from "react";

import { useChat } from "../store.js";
import { localEmailProblem } from "../lib/authError.js";
import { MIN_PASSWORD, NAME_MAX, canSubmitSignIn, confirmHint } from "../lib/signInForm.js";
import { ConfirmEmailDialog } from "./ConfirmEmailDialog.js";
import { ForgotPasswordDialog } from "./ForgotPasswordDialog.js";
import { HINT } from "../settingsShell.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
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

/** 卡壳。用 shadcn 的 `Card`，只把它默认的 `py-6 / gap-6` 收紧 —— 那份留白是
    给正文排版的，卡里三段全是控件，照搬会散。`glass` 只在进门闸上用：那一屏铺着
    dither 动效，不透一点、不糊一层的话卡是"贴"在画面上而不是"坐"在画面里；
    账号页背后是一块纯色，糊它没有意义，还会把卡的色调压掉一点点 */
const CARD = "w-full max-w-[320px] gap-0 py-[12px]";
/** 段内。8px 是段间距的一半 —— 分组全靠这个比值读出来 */
const SECTION = "flex flex-col gap-[8px]";

export function SignInCard({
  className,
  variant = "plain",
}: {
  className?: string;
  variant?: "plain" | "glass";
}) {
  const signIn = useChat((s) => s.signIn);
  const signInWithPassword = useChat((s) => s.signInWithPassword);
  const signUpWithPassword = useChat((s) => s.signUpWithPassword);
  const setError = useChat((s) => s.setError);
  // mode 提到这一层:切换它的那颗按钮已经不在表单里了(它自己是第三块面板),
  // 但它管的仍然是表单的文案与 autoComplete
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  /** 注册时的用户名。原来是进了 app 才在引导弹窗里填(issue #95),现在挪到注册这一步 */
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  /** 注册时的「再输一遍」。密码是看不见的,一个字母打错就是一次找不回的账号 */
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  /** 注册成功、正在等确认邮件。存的是那一刻的邮箱密码 —— 弹窗要拿它轮询探测
      （见 ConfirmEmailDialog）。只活在内存里，不落盘、不进日志 */
  const [pending, setPending] = useState<{ email: string; password: string } | null>(null);
  /** 忘记密码那张弹窗开着没有。整段流程（填邮箱→收验证码→填回来）都在它里面，
      这里只管开关（issue #741） */
  const [forgotOpen, setForgotOpen] = useState(false);

  const card = cn(CARD, variant === "glass" && "bg-card/85 shadow-2xl backdrop-blur-xl");
  const form = { mode, name, email, password, confirm, busy };
  const canSubmit = canSubmitSignIn(form);
  const mismatch = confirmHint(form);

  const submit = async () => {
    if (!canSubmit) return;
    // 本地预检:形状一眼不对就别跑这趟网络。报文与 supabase 一致,
    // 所以右下角那张卡的话术走的是同一条规则(lib/authError.ts)
    const bad = localEmailProblem(email.trim());
    if (bad) {
      setError(bad);
      return;
    }
    setBusy(true);
    try {
      if (mode === "sign-in") {
        await signInWithPassword(email, password);
      } else {
        const result = await signUpWithPassword(email, password, name.trim());
        // 注册即登录(项目关掉邮箱确认时)那条路什么都不用做:onAccountChanged 会推登录态
        if (result === "confirm-email") setPending({ email: email.trim(), password });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={cn(card, className)}>
      <CardContent className="flex flex-col gap-[16px] px-[12px]">
      {/* 一：邮箱密码。OAuth 两颗不放进这个 <form> —— 它们不是提交这张表单的动作，
          放进来还得逐个写 type="button" 才不会误触发提交 */}
      {/* noValidate:关掉 Chromium 自己那套校验。它对 `a@` 会弹一个英文灰气泡并
          **拦下提交**,我们的报错卡就永远轮不到;而 `a@qq` 它又放行。两种都归本地
          预检管(见 submit 里的 localEmailProblem),报错口径才只有一个 */}
      <form
        noValidate
        className={SECTION}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* 用户名排在邮箱**上面**:它是"你叫什么",邮箱密码是"怎么进来",
            前者才是这张表单在问的第一件事 */}
        {mode === "sign-up" && (
          <Input
            placeholder="用户名"
            autoComplete="nickname"
            maxLength={NAME_MAX}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <Input
          type="email"
          placeholder="邮箱"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Input
          type="password"
          placeholder={mode === "sign-up" ? `密码（至少 ${MIN_PASSWORD} 位）` : "密码"}
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {/* 注册才有的第二格。`aria-invalid` 让不一致时的红边由 Input 自己画 —— 
            不另写一套样式 */}
        {mode === "sign-up" && (
          <>
            <Input
              type="password"
              placeholder="再输一遍密码"
              autoComplete="new-password"
              aria-invalid={mismatch !== null}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {/* 贴着那一格念，不去右下角 —— 这是一个**边打字边改**的问题，
                提示必须待在他正在看的地方（服务端往返失败的那类才归那张卡） */}
            {mismatch && <p className="px-[2px] text-[12px] text-err">{mismatch}</p>}
          </>
        )}
        <Button type="submit" disabled={!canSubmit} className="w-full">
          {busy ? "…" : mode === "sign-in" ? "用邮箱登录" : "注册"}
        </Button>
      </form>

      {/* 二：OAuth */}
      <div className={SECTION}>
        <Button variant="outline" className="w-full" onClick={() => void signIn("google")}>
          <GoogleIcon />
          用 Google 登录
        </Button>
        <Button variant="outline" className="w-full" onClick={() => void signIn("github")}>
          <GitHubIcon />
          用 GitHub 登录
        </Button>
      </div>

      {/* 三：两条**离开这张表单**的路，一行两端分开摆。
          它们既不是登录方式(所以不给边框、不挨着 OAuth)，彼此也不是一回事：
          左边是"我进不去了"，右边是"我还没有账号"。注册态没有左边那条 ——
          那一屏还不存在"旧密码"这回事，但右边仍要靠右，所以留一个空位撑住 */}
      <div className="flex items-center justify-between">
        {mode === "sign-in" ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-[12px] text-muted-foreground"
            onClick={() => setForgotOpen(true)}
          >
            忘记密码？
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-[12px] text-muted-foreground"
          onClick={() => {
            setMode(mode === "sign-in" ? "sign-up" : "sign-in");
            setName("");
            setConfirm("");
            setPending(null);
          }}
        >
          {mode === "sign-in" ? "没有账号？注册" : "已有账号？登录"}
        </Button>
      </div>
      </CardContent>
      {/* 忘记密码。验证成功那一刻人就是登录态了,这棵树跟着卸载 ——
          第三步「设新密码」由 App 那层的 SetPasswordDialog 接手 */}
      {forgotOpen && (
        <ForgotPasswordDialog initialEmail={email} onClose={() => setForgotOpen(false)} />
      )}

      {/* 等确认邮件那张弹窗。它自己 portal 到 body，挂在这儿只是为了好找 */}
      {pending && (
        <ConfirmEmailDialog
          email={pending.email}
          password={pending.password}
          onClose={() => {
            setPending(null);
            setMode("sign-in");
            setName("");
            setConfirm("");
          }}
        />
      )}
    </Card>
  );
}
