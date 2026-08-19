// AssistantRuntimeProvider 的壳。单独成文件是为了让 App.tsx 只 import 一个名字。
//
// 名字不叫 AuiProvider:assistant-ui 自己导出了一个同名组件(@assistant-ui/react
// 的 AuiProvider),重名会让人以为在用官方那个

import type { ReactNode } from "react";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useOttoRuntime } from "./useOttoRuntime.js";

export function OttoRuntimeProvider({ children }: { children: ReactNode }) {
  const runtime = useOttoRuntime();
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}
