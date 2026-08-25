// friends — 好友系统的共享类型(三边共 import:main/preload/renderer)。
// 纯类型 + 零运行时依赖,遵守 shellBridge.ts 的"共享世界"约定。
// 行形状与 supabase/migrations/0001_friends.sql 的列一一对应。

/** profiles 表一行的渲染层形态(snake_case 列名在主进程归一成 camelCase) */
export interface FriendProfile {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

/** 一条好友关系,从"我"的视角展开:profile 是对方,direction 是请求方向 */
export interface FriendshipEntry {
  friendshipId: string;
  profile: FriendProfile;
  status: "pending" | "accepted";
  /** incoming = 对方发给我的请求;outgoing = 我发出的请求。accepted 后无所谓方向,保留事实 */
  direction: "incoming" | "outgoing";
}

/** listFriends / onFriendsChanged 的全量快照(量小,快照比增量简单) */
export interface FriendsSnapshot {
  friends: FriendshipEntry[];
  incoming: FriendshipEntry[];
  outgoing: FriendshipEntry[];
}

export interface DirectMessage {
  id: number;
  sender: string;
  recipient: string;
  body: string;
  /** ISO 8601(supabase timestamptz 原样传) */
  createdAt: string;
}

/** 实时链路健康度(主进程判定,渲染层只显示):
    connecting = 正在建订阅;live = postgres_changes/presence 都通;
    degraded = 订阅报错/超时,已切到轮询兜底(功能仍在,只是慢几秒)。
    存在的理由见 ADR-0027 —— 实时链路断了也不能让好友/私信整条失效 */
export type RealtimeHealth = "connecting" | "live" | "degraded";

/** 好友 bridge 方法的错误形态(spec 裁定):网络/RLS 拒绝不 throw,结构化回流,
    渲染层拿 message 做内联提示。throw 只留给"渲染层送来非法参数"这类编程错误 */
export type FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** 一个工作区的"在场"信息:在哪个仓库、哪个分支(issue #167,ADR-0055)。
    repoKey = 规范化 remote URL 的 hash(shared/repoKey.ts 规范化,主进程 hash),
    好友之间只能比对"同不同一个仓库",看不到地址本身。
    branch = 本地短名;detached HEAD 时为 null(在仓库里但不在任何分支上) */
export interface WorkspacePresence {
  repoKey: string;
  branch: string | null;
}

/** 某个好友此刻在哪(只含在线好友;离线的人不在列表里) */
export interface FriendWorkspace extends WorkspacePresence {
  userId: string;
}

/** onWorkspacesChanged 的全量推送:我自己在哪 + 好友们在哪。
    mine 一起推是因为渲染层过滤"同仓库"要拿我的 repoKey 作基准 */
export interface WorkspacesSnapshot {
  mine: WorkspacePresence | null;
  friends: FriendWorkspace[];
}
