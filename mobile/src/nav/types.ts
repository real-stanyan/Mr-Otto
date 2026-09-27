// 导航的路由表（#1356）：一个原生栈。第一层只有一个主语——我有哪几只智能体——名册是栈底，
// 其余一律推进来。
import type { ChatTarget } from "../../../src/shared/mobileChat.js";

export type RootStackParams = {
  Roster: undefined;
  /** 私聊按 agentId 进（还没聊过就是草稿），群按 sessionId 进 */
  Chat: ChatTarget;
  Account: undefined;
  /** 订阅（A5）：账号页「订阅」那一行、名册进门「没订阅 / 档位不带」那颗钮进来 */
  Subscription: undefined;
  /** 那台电脑上的一层文件夹（A5）；path 相对 /work，"" = 最外层。点子目录压一页同名屏 */
  Files: { path: string };
  /** 一个文件（A5）：只读，开头 64 KB */
  FilePreview: { path: string };
  /** 记忆清单（A5）：它们自己维护的 wiki */
  Wiki: undefined;
  /** 记忆里的一页（A5）；path 是 wiki/ 底下的相对路径，如 customers/acme.md */
  WikiPage: { path: string };
  /** 改记忆里的一页（A5） */
  WikiEdit: { path: string };
  AgentSettings: { agentId: string };
  /** 建群（A3）：从 ＋ 那张岔路弹窗的「一个群聊」推进来 */
  NewGroup: undefined;
  /** 群设置（A3）：从群聊头部右边那颗进来 */
  GroupSettings: { sessionId: string };
  FaceGallery: undefined;
};

// 让不带泛型的 useNavigation() 也认得这些屏
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface RootParamList extends RootStackParams {}
  }
}
