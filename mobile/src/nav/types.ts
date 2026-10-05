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
  | { kind: "guest"; workspaceId: string; sessionId: string }
  /** 别人的智能体给我打电话的外联会话（#1441）：workspaceId 是对方的主场。只有来电记录与一句说明，没有聊天信息页 */
  | { kind: "outreach"; workspaceId: string; sessionId: string };

/** 聊天信息页：云会话那三种 + 朋友私聊（外联会话没有） */
export type InfoRoute = Exclude<ChatRoute, { kind: "outreach" }> | { kind: "friend"; uid: string };

export type RootStackParams = {
  Home: NavigatorScreenParams<HomeTabParams> | undefined;
  /** autoCall：从智能体资料点「语音通话」进来——房间一 ready 就把电话打出去（一次）。
      answerRing：从来电页点「接听」进来（#1411）——房间一 ready 就把打电话的那只拉进通话（一次） */
  /** dispatch（#1505）：长按别处的一条消息派过来的开场白——房间一能发就把它发出去（一次），私聊还没建就顺手建 */
  /** callAgentId（#1550）：autoCall 只拉这一只进通话（私聊页「给 TA 的智能体打电话」——车道里可能带着别的智能体），挂断就回上一页 */
  /** callOnly（#1558）：这一页只画通话——标题是那只的名字、不画时间线与输入框；与 callAgentId 一起给。挂断回上一页 */
  Chat: ChatRoute & { autoCall?: boolean; callAgentId?: string; callOnly?: boolean; answerRing?: { ringId: string; agentId: string }; dispatch?: string };
  /** 朋友私聊（messages 表，不是云会话） */
  FriendChat: { uid: string };
  /** 我带进和这位朋友私聊的智能体（#1642）：私聊页里点我自己的头像进来——给谁看、带上、移除 */
  LaneAgents: { uid: string };
  /** 朋友带来的智能体（#1653）：私聊页里点朋友的头像进来，只读。agents / hidden 是私聊页那一刻头像底下那一排的快照 */
  PeerLaneAgents: { uid: string; agents: { agentId: string; name: string; slot: number; description: string }[]; hidden: number };
  /** 人与人的通话页（#1534）：哪一通、和谁、是不是来电。状态在 call/humanCall.ts 的 store 里 */
  HumanCall: { callId: string; friendUid: string; incoming: boolean };
  ChatInfo: InfoRoute;
  /** 智能体资料。workspaceId 缺席 = 我主场里的（能改）；给了 = 团队里的 / 别人群里的（别人的，只看） */
  Agent: { agentId: string; workspaceId?: string };
  /** 一只智能体的定时任务（#1283）：只有我主场里的有 */
  Routines: { agentId: string };
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
  /** 应用（A5；#1430 起上段是手机上接的、下段是电脑上接的；#1591 起最上段是我的应用） */
  Apps: undefined;
  /** 一个 Otto 应用（#1591）：WebView 宿主 + 桥 */
  /** share（#1648）：从抽屉长按「分享给朋友」进来——一打开就弹挑朋友 */
  MiniApp: { appId: string; share?: boolean };
  /** 接入应用（#1430）：目录 + 搜索 */
  ConnectApp: undefined;
  /** 手机上接的一台（#1430）：工具 / 借给团队 / 重新登录 / 断开。serverId = 云端视图里的那一格 */
  AppDetail: { serverId: string };
  /** 设置：外观 / 连接诊断 / 版本 / 退出登录 */
  Settings: undefined;
  /** 免打扰时段 + 管理员定时汇报（#1569） */
  QuietHours: undefined;
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
