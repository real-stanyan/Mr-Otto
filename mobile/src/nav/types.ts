// 导航的路由表（#1386，微信式布局）：一个原生栈，栈底是一个页签屏（聊天 / 通讯录 / 我），其余一律推进来，
// 推进来的页盖住底栏（照 iOS 微信）。原生栈与左缘右划原样（ADR-0293 决定 2）。
import type { NavigatorScreenParams } from "@react-navigation/native";
import type { ChatTarget } from "../../../src/shared/mobileChat.js";

export type HomeTabParams = {
  Chats: undefined;
  Contacts: undefined;
  Me: undefined;
};

/** 一条云会话线：主场的私聊（按 agentId，还没聊过是草稿）/ 主场的群 / 团队里的一条会话（= 有真人的群）/
    别人主场里拉我进去的群（#1393，workspaceId 是群主的主场） */
export type ChatRoute =
  | ChatTarget
  | { kind: "team"; workspaceId: string; sessionId: string }
  | { kind: "guest"; workspaceId: string; sessionId: string };

/** 聊天信息页：云会话那三种 + 朋友私聊 */
export type InfoRoute = ChatRoute | { kind: "friend"; uid: string };

export type RootStackParams = {
  Home: NavigatorScreenParams<HomeTabParams> | undefined;
  /** autoCall：从智能体资料点「语音通话」进来——房间一 ready 就把电话打出去（一次）。
      answerRing：从来电页点「接听」进来（#1411）——房间一 ready 就把打电话的那只拉进通话（一次） */
  Chat: ChatRoute & { autoCall?: boolean; answerRing?: { ringId: string; agentId: string } };
  /** 朋友私聊（messages 表，不是云会话） */
  FriendChat: { uid: string };
  ChatInfo: InfoRoute;
  /** 智能体资料。workspaceId 缺席 = 我主场里的（能改）；给了 = 团队里的 / 别人群里的（别人的，只看） */
  Agent: { agentId: string; workspaceId?: string };
  Friend: { uid: string };
  /** 新的朋友：别人加我的 / 我加别人的 */
  Requests: undefined;
  /** 群聊：所有群一列 */
  Groups: undefined;
  /** 个人信息：头像 / 名字 / 邮箱 / 改密码 */
  Profile: undefined;
  /** 订阅与额度 */
  Quota: undefined;
  /** 订阅（A5）：挑一档 / 换档 */
  Subscription: undefined;
  /** 那台电脑上的一层文件夹（A5）；path 相对 /work，"" = 最外层。点子目录压一页同名屏 */
  Files: { path: string };
  /** 一个文件（A5）：只读，开头 64 KB */
  FilePreview: { path: string };
  /** 记忆清单（A5） */
  Wiki: undefined;
  WikiPage: { path: string };
  WikiEdit: { path: string };
  /** 这周谁用得多（A5） */
  Usage: undefined;
  /** 应用（A5）：接着的那几个，只列 */
  Apps: undefined;
  /** 设置：外观 / 连接诊断 / 版本 / 退出登录 */
  Settings: undefined;
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
