// 导航的路由表（#1356）：一个原生栈。第一层只有一个主语——我有哪几只智能体——名册是栈底，
// 其余一律推进来。
import type { ChatTarget } from "../../../src/shared/mobileChat.js";

export type RootStackParams = {
  Roster: undefined;
  /** 私聊按 agentId 进（还没聊过就是草稿），群按 sessionId 进 */
  Chat: ChatTarget;
  Account: undefined;
  AgentSettings: { agentId: string };
  /** 建群（A3）：从 ＋ 那张岔路弹窗的「一个群聊」推进来 */
  NewGroup: undefined;
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
