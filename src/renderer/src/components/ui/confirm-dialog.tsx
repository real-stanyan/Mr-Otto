// confirm-dialog —— 二次确认弹窗，取代 `window.confirm`（#1127）。
//
// ## 为什么不是原生 confirm
//
// #1120 写过一句「保留 `confirm()`……不新造一套 AlertDialog 视觉语言」，那条理由
// 站不住：视觉语言早就在仓库里（`ForgotPasswordDialog` / `SetPasswordDialog` /
// `ConfirmEmailDialog` 三处在用 `ui/alert-dialog`），保留原生的代价才是真的——它
// 长着操作系统的脸、写着 Electron 的应用名、按钮永远是英文的「OK / Cancel」，而且
// 一整块文字里分不出「问的是什么」与「后果是什么」。
//
// ## 形状：一个 Promise，不是一堆 open state
//
// 原生 `confirm()` 同步返回 boolean，21 个调用点都是 `if (!confirm(…)) return;`
// 这个形状。给每处各挂一段 JSX + 一个 open state，就是把一件事抄二十一遍。
// `useConfirm()` 回一个 `(opts) => Promise<boolean>`，调用点只多一个 `await`。
//
// **provider 缺席时 `useConfirm` 抛错**（同 `useNav`）——不回落到 `window.confirm`：
// 那种回落会让「忘了挂 provider」表现成「弹窗长得不对」，而这正是本文件要修的事。
//
// ## 队列而不是「弹着的时候丢掉新的」
//
// modal 挡着，用户点不出第二个；但程序路径可以（比如一次操作连问两句）。丢掉的那个
// promise 永远不 resolve = 调用点永远 await 下去，是个不会报错的死等。排队十行，
// 且卸载时把没答的一律按「取消」收口。
//
// **摘队列的副作用不写在 `setState` 的 updater 里**（ADR-0264 同一条）：StrictMode
// 会把 updater 跑两遍，`resolve` 跟着跑两遍。真相在 `queueRef`，state 只驱动渲染。
//
// ## 退场动画期间画什么
//
// 队头一摘，`open` 就变 false，而 Radix 的退场动画还要跑 140ms——那段时间里内容
// 不能跟着消失（否则是一张空卡片淡出）。`shown` 记住最后显示过的那份，直到下一个
// 请求把它换掉。

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";

export interface ConfirmOptions {
  /** 问的是什么。一句话，带问号 */
  title: string;
  /** 后果是什么。原生 confirm 里挤在同一块文字里的后半段 */
  description?: ReactNode;
  /** 确认钮上的字。默认「确定」——**危险动作请写出动词**（「删除」「解散」） */
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` = 确认钮画成 destructive。不可逆的动作用它 */
  tone?: "default" | "danger";
}

interface Req extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function useConfirm(): ConfirmFn {
  const fn = useContext(ConfirmContext);
  if (!fn) throw new Error("useConfirm 必须在 <ConfirmProvider> 里用");
  return fn;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const queueRef = useRef<Req[]>([]);
  const [queue, setQueue] = useState<Req[]>([]);
  const [shown, setShown] = useState<Req | null>(null);

  const head = queue[0];
  // 渲染期间就地调整（React 官方那条 "adjusting state when props change"），
  // **不走 effect**：effect 慢一拍，而队头换人与那张卡上该写什么必须是同一帧的事——
  // 否则答完第一个之后有一帧画着第一个的文字、开关却已经指向第二个
  if (head && head !== shown) setShown(head);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        queueRef.current = [...queueRef.current, { ...opts, resolve }];
        setQueue(queueRef.current);
      }),
    []
  );

  // 按钮只**记下**答案，真正结算在 `onOpenChange(false)` 那一刻——两处都 settle 的话
  // 一次点击摘两个（Radix 在跑完调用方的 onClick 之后自己会关闭，于是 settle 连着
  // 跑两遍，排在后面那个问题连问都没问就被答成了「取消」）。所以关闭是唯一出口，
  // 按钮、ESC、点外面全走它
  const answerRef = useRef(false);

  const settle = useCallback((ok: boolean) => {
    const [first, ...rest] = queueRef.current;
    if (!first) return;
    queueRef.current = rest;
    setQueue(rest);
    answerRef.current = false;
    first.resolve(ok);
  }, []);

  // 卸载时把没答完的按「取消」收口：不收的话那几个 promise 永远不 resolve，
  // 调用点停在 await 上等一个再也不会来的答案
  useEffect(
    () => () => {
      const pending = queueRef.current;
      queueRef.current = [];
      for (const r of pending) r.resolve(false);
    },
    []
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog open={head !== undefined} onOpenChange={(o) => { if (!o) settle(answerRef.current); }}>
        {shown && (
          <AlertDialogContent size="sm">
            <AlertDialogHeader>
              <AlertDialogTitle>{shown.title}</AlertDialogTitle>
              {shown.description !== undefined && (
                <AlertDialogDescription className="whitespace-pre-line">
                  {shown.description}
                </AlertDialogDescription>
              )}
            </AlertDialogHeader>
            <AlertDialogFooter>
              {/* 取消排在前面：`size="sm"` 下页脚是 grid，DOM 顺序就是左右顺序。
                  焦点也落在它身上（Radix 的 AlertDialog 默认把焦点给 Cancel）——
                  一个不可逆的动作不该按回车就发生 */}
              <AlertDialogCancel onClick={() => { answerRef.current = false; }}>
                {shown.cancelLabel ?? "取消"}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={shown.tone === "danger" ? "destructive" : "default"}
                onClick={() => { answerRef.current = true; }}
              >
                {shown.confirmLabel ?? "确定"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </ConfirmContext.Provider>
  );
}
