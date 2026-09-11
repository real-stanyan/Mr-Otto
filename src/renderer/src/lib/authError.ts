// 桌面渲染层那一层包装：先剥 Electron IPC 的壳（bridgeError.ts），再交给两端共用的规则表
// （src/shared/authError.ts，#1237 M1 挪过去的——手机端要同一份翻译）。
// 入参给什么都行：Error、字符串、store.error 里那份已经剥过壳的文本；剥壳是幂等的。
import { bridgeErrorMessage } from "./bridgeError.js";
import { authNoticeOf, type AuthNotice } from "../../../shared/authError.js";

export type { AuthNotice };
export { localEmailProblem } from "../../../shared/authError.js";

export function authNotice(e: unknown): AuthNotice {
  return authNoticeOf(bridgeErrorMessage(e));
}
