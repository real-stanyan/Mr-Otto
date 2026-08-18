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

/** 好友 bridge 方法的错误形态(spec 裁定):网络/RLS 拒绝不 throw,结构化回流,
    渲染层拿 message 做内联提示。throw 只留给"渲染层送来非法参数"这类编程错误 */
export type FriendsResult<T> = { ok: true; value: T } | { ok: false; message: string };
