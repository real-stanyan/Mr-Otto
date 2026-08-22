// 一条 model_changed 事件 → 这一次交接的两端。
//
// 日志里每条 model_changed 只记落点("换成了谁"),没记来处 —— 来处是**推出来**的:
// 它就是上一条 model_changed;再往前没有,就看这次切换之前最后一条 assistant_message
// 的 model 字段 —— 那是"实际生成这条的模型",是事实不是配置,拿来当来处不算编。
// 连一条回复都还没有就切了(开局先换模型)才真的没有来处,这时不画来源
// (见 elements/agent-handoff 的本仓改动②)。会话默认模型仍然不猜:日志没记它。
//
// settled = 这次交接后来又被下一次覆盖了。当前生效的那一次不 settled ——
// 一屏里可能有好几条切换行,读的人真正要认出的是"现在跑的是哪一个"。
//
// 纯函数、不 import 渲染层的东西:vitest 直接跑(测试不解析 @/ 别名)

import type { SessionEvent } from "../../../session/events.js";
import { findModel } from "../../../shared/modelCatalog.js";

export interface ModelSide {
  provider: string;
  model: string;
}

export interface ModelHandoff {
  /** 缺席 = 这是会话里的第一次切换,来处是"默认模型",日志没记 */
  from?: ModelSide;
  to: ModelSide;
  settled: boolean;
}

export function modelHandoff(events: readonly SessionEvent[], seq: number): ModelHandoff | null {
  const switches = events.filter((e) => e.type === "model_changed");
  const i = switches.findIndex((e) => e.seq === seq);
  const self = switches[i];
  if (i === -1 || !self || self.type !== "model_changed") return null;
  const prev = switches[i - 1];
  const from =
    prev && prev.type === "model_changed"
      ? { provider: prev.provider, model: prev.model }
      : lastReplyModel(events, seq);
  return {
    ...(from ? { from } : {}),
    to: { provider: self.provider, model: self.model },
    settled: i < switches.length - 1,
  };
}

/** chip 上写什么:只写型号,不写厂商前缀。
    厂商已经由旁边那枚标记(ProviderMark)说了 —— 再写一遍 "glm/" 是同一件事
    讲两遍,而型号名才是这一行要认的东西。
    前缀本来就在 id 里的(Ollama 的 "ollama/qwen3:8b")照样脱掉;
    带**别家**命名空间的(OpenRouter 的 "anthropic/claude-sonnet-5")留着 ——
    那两截说的是两件事:谁在转发、转发的是谁 */
export function modelSideLabel(side: ModelSide): string {
  const prefix = `${side.provider}/`;
  return side.model.startsWith(prefix) ? side.model.slice(prefix.length) : side.model;
}

/** 这次切换之前最后一条回复是谁生成的。assistant_message.model 只记型号 id,
    厂商从目录反查;目录里没有(自定义/已下架)但带 "x/" 前缀的,前缀就是厂商;
    两样都没有就认不出,不硬凑 */
function lastReplyModel(events: readonly SessionEvent[], before: number): ModelSide | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.seq >= before || e.type !== "assistant_message") continue;
    const provider = findModel(e.model)?.provider ?? e.model.split("/")[0];
    if (!provider || provider === e.model) return undefined;
    return { provider, model: e.model };
  }
  return undefined;
}
