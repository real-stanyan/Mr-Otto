// AuthErrorAlert — 登录/注册失败时右下角弹的那张卡（issue #736）。
//
// 位置选右下角而不是卡片下方：登录卡在屏幕正中，报错顶在它下面会把整块内容
// 往上推、按钮跟着跳；右下角是个固定的坑位，出现与消失都不动别人。
//
// 话术不在这里，在 `lib/authError.ts`（纯函数、有测试）—— 这个文件只管
// 「什么时候出现、怎么进场、怎么消失」。
//
// 自己会走，也点得掉：错误不该永远杵在那儿，但**读完一句中文要几秒**，
// 所以给到 8 秒；`store.error` 在每次重新提交时都会被清（见 store 的
// signIn / signInWithPassword / signUpWithPassword，进门先 set null），
// 所以「上一次的错还挂着」这种事不会发生。

import { useEffect, useState } from "react";
import { TriangleAlert, X } from "lucide-react";

import { useChat } from "../store.js";
import { authNotice } from "../lib/authError.js";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";

/** 停留多久。一句中文读两遍的时间 */
const LINGER_MS = 8000;
/** 进场/退场。退场比进场快 —— 用户已经不看它了（进 220 / 出 160） */
const IN_MS = 220;
const OUT_MS = 160;

export function AuthErrorAlert() {
  const error = useChat((s) => s.error);
  const setError = useChat((s) => s.setError);
  // 三档:没有 / 在场 / 正在退场。退场要留一帧给 transition,不能直接卸载
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!error) {
      setShown(false);
      return;
    }
    // 下一帧才翻 true:同一帧里设初值和终值,浏览器不会插值
    const raf = requestAnimationFrame(() => setShown(true));
    const linger = setTimeout(() => setShown(false), LINGER_MS);
    // 退场动画走完再真的清掉 store.error —— 先清的话组件当场卸载,看不到退场
    const clear = setTimeout(() => setError(null), LINGER_MS + OUT_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(linger);
      clearTimeout(clear);
    };
  }, [error, setError]);

  if (!error) return null;
  const notice = authNotice(error);

  const dismiss = (): void => {
    setShown(false);
    setTimeout(() => setError(null), OUT_MS);
  };

  return (
    <div
      className="fixed bottom-[16px] right-[16px] z-[60] w-[min(360px,calc(100vw-32px))] transition-[opacity,transform] ease-[var(--ease-strong)] motion-reduce:transition-none"
      style={{
        transitionDuration: `${shown ? IN_MS : OUT_MS}ms`,
        opacity: shown ? 1 : 0,
        // 从右下角自己的方向滑进来 —— 它是从那个角"长"出来的,不是凭空出现
        transform: shown ? "none" : "translateY(8px) scale(0.98)",
      }}
      data-testid="auth-error"
    >
      <Alert variant="destructive" className="bg-card/95 shadow-2xl backdrop-blur-xl">
        <TriangleAlert />
        <AlertTitle>{notice.title}</AlertTitle>
        {(notice.hint || notice.raw) && (
          <AlertDescription>
            {notice.hint && <p>{notice.hint}</p>}
            {/* 认不出来的原文降级成小字:翻不动的报错也不能凭空吞掉,
                否则用户没法求助、我们也没法排查 */}
            {notice.raw && <p className="font-mono text-[11px] opacity-70">{notice.raw}</p>}
          </AlertDescription>
        )}
        {/* 关闭键压在右上角。Alert 是 grid,绝对定位的孩子不占格子 */}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="关闭"
          className="absolute right-[6px] top-[6px] text-muted-foreground"
          onClick={dismiss}
        >
          <X />
        </Button>
      </Alert>
    </div>
  );
}
