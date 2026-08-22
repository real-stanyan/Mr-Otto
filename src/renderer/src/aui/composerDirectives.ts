// 输入框里的 directive 高亮:把正在打的文本切成 text / mention 两种段。
//
// 两套 formatter(`$skill` 和 `/指令`)各认各的,这里串起来跑:先按 `$` 切,
// 切出来的 text 段再按 `/` 切。纯函数,给 ComposerHighlight(App.tsx)用。

import type { Unstable_DirectiveFormatter, Unstable_DirectiveSegment } from "@assistant-ui/react";

export function segmentComposerText(
  text: string,
  formatters: readonly Unstable_DirectiveFormatter[]
): readonly Unstable_DirectiveSegment[] {
  let segs: readonly Unstable_DirectiveSegment[] = [{ kind: "text", text }];
  for (const f of formatters) {
    segs = segs.flatMap((s) => (s.kind === "text" ? f.parse(s.text) : [s]));
  }
  return segs;
}
