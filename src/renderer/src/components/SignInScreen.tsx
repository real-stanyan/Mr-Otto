// SignInScreen — 进门那道闸（ADR-0182）。没有登录记录时，App 画的就只有这一屏。
//
// 三个不显眼但缺一不可的地方：
//
//  1. **背景和启动画面是同一份**（`DitherBackground`，shader 在 `shared/dither.ts`）。
//     不是为了好看统一：冷启动的顺序是 Splash 盖在上面淡出、这一屏在底下等着，
//     两层背景不是同一个东西的话，那 360ms 的淡出会变成一次"换了张皮"的闪动。
//  2. **整屏是 `.drag-region`**。窗口是无边框的（`titleBarStyle` 藏了标题栏），
//     平时靠头部那条 `HEADER` 接住拖拽 —— 而这一屏没有头部。不铺这一层的话，
//     没登录的用户连窗口都挪不动。按钮/输入框由 `app.css` 的后代规则自动 `no-drag`。
//  3. **错误要在这儿显示**。密码错、邮箱没注册这类失败走的是 `store.error`
//     （`signInWithPassword` 自己不抛给表单），这一屏不画它 = 点了登录毫无反应。

import { useEffect, useState } from "react";

import { useChat } from "../store.js";
import { ERR_TXT } from "../settingsShell.js";
import { DitherBackground } from "./DitherBackground.js";
import { SignInCard } from "./SignInCard.js";

/** 入场时长。这一屏一辈子只见两次（首次开 app、登出之后），给得起一点排场，
    但仍然压在 300ms 以内 —— 它后面跟着的是"我要开始干活了" */
const ENTER_MS = 260;

export function SignInScreen() {
  const error = useChat((s) => s.error);
  // 主题跟 Splash 同一个口径：挂载时读一次。这一屏够不着外观设置，中途不会变
  const [dark] = useState(() => document.documentElement.classList.contains("dark"));
  const [shown, setShown] = useState(false);

  // 下一帧才翻 shown：同一帧里设初值和终值，浏览器不会插值（transition 需要
  // 两次布局之间的差）。rAF 而不是 setTimeout(0)——后者可能落在同一帧里
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="drag-region fixed inset-0 z-50 bg-background" data-testid="sign-in-screen">
      <DitherBackground className="absolute inset-0 h-full w-full" dark={dark} />
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
        <div
          className="w-full max-w-[360px] transition-[opacity,transform] ease-[var(--ease-strong)] motion-reduce:transition-none"
          style={{
            transitionDuration: `${ENTER_MS}ms`,
            opacity: shown ? 1 : 0,
            // 不从 scale(0) 起：现实里没有东西从"没有"里长出来。10px + 0.98
            // 已经够读出"它是落下来的"，再多就成了弹窗特效
            transform: shown ? "none" : "translateY(10px) scale(0.98)",
          }}
        >
          {/* 卡片压在动效背景上：半透明 + 背板模糊，让它坐在画面里而不是贴在画面上。
              backdrop-filter 失败是静默的（整条被丢掉），届时退回不透明卡，仍然读得清 */}
          <SignInCard className="bg-card/85 shadow-2xl backdrop-blur-xl" />
        </div>
        {/* 密码错这类失败只会落在 store.error 里，卡片自己不显示它 */}
        {error && <p className={`${ERR_TXT} max-w-[360px] text-center`}>{error}</p>}
      </div>
    </div>
  );
}
