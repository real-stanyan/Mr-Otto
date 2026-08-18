// 渲染层的最后一道网。
//
// 起因(issue #51):一个第三方组件在 passive effect 里抛了个 TypeError,
// React 把整棵树卸载,#root 变成空 div —— 用户看到的是**纯黑一片**,
// 没有任何线索,连"哪个会话打不开"都得靠猜。
//
// 崩溃本身修得掉,但"崩溃 = 黑屏"这条路必须堵死:界面可以坏,不能哑。
// 这里不做重试魔法,只做两件事:把错误原文摆出来,给一个重载按钮。

import React from "react";

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // devtools 里仍要留全栈:上面那条只够人看,查因还得靠这个
    console.error("渲染崩溃", error, info.componentStack);
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-full w-full flex items-center justify-center p-6 bg-background text-foreground">
        <div className="max-w-[560px] w-full flex flex-col gap-3 rounded-[10px] border border-border p-5">
          <h1 className="text-base font-[650]">界面崩了</h1>
          <p className="text-[13px] text-muted-foreground leading-[1.6]">
            这是渲染层的异常，不影响已经落盘的会话日志——事件日志是 append-only 的，
            重载后会话原样还在。
          </p>
          <pre className="text-[12px] whitespace-pre-wrap break-words rounded-[6px] bg-muted px-3 py-2 max-h-[240px] overflow-auto">
            {error.message || String(error)}
          </pre>
          {error.stack && (
            <details className="text-[12px] text-muted-foreground">
              <summary className="cursor-pointer select-none">调用栈</summary>
              <pre className="mt-2 whitespace-pre-wrap break-words max-h-[240px] overflow-auto">
                {error.stack}
              </pre>
            </details>
          )}
          <button
            type="button"
            className="self-start rounded-[6px] border border-border px-3 py-[6px] text-[13px] transition-transform duration-100 ease-out active:scale-[0.97] motion-reduce:active:scale-100"
            onClick={() => window.location.reload()}
          >
            重新载入
          </button>
        </div>
      </div>
    );
  }
}
