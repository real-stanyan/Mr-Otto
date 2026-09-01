// @好友 补全列表里的一条 = 一个人(issue #831)。
//
// 为什么单独一个文件:这里有两条判定,都不该埋在 App.tsx 的 useMemo 里 ——
// ① 一行显示哪几个字段(头像 / 显示名 / 邮箱)
// ② 输入的那几个字拿去比对哪几个字段
// 这两条必须一致:**列表上写着的字,必须搜得出来**。显示邮箱却只按名字过滤,
// 用户看着 `@Mingxuan Zhang  mx@example.com` 打 `mx`,列表当场空了 —— 界面
// 摆出一个字段又不认它,和界面骗人是同一类毛病(ADR-0106 那条职责墙的同款)。
//
// 纯函数,不碰 React:两条判定各自可测。

import type { FriendProfile } from "../../../shared/friends.js";

/** 补全条目。metadata 三个键的语义见 composer-trigger-popover.tsx 的 personBits */
export interface FriendMentionItem {
  readonly id: string;
  readonly type: "friend";
  readonly label: string;
  readonly metadata: {
    readonly avatar: string;
    readonly avatarLabel: string;
    readonly trailing: string;
  };
}

/**
 * 好友名单 → 补全条目。
 *
 * `label` 仍是 `@显示名`(formatter 那头按 label 剥 `@` 写回输入框,ottoDirectives),
 * 头像/邮箱走 metadata —— 显示名没填的人拿邮箱顶上首字母那一格,不然圆片上是个 `?`。
 */
export function friendMentionItems(
  friends: readonly { readonly profile: FriendProfile }[]
): FriendMentionItem[] {
  return friends.map((e) => ({
    id: e.profile.id,
    type: "friend" as const,
    label: `@${e.profile.name}`,
    metadata: {
      avatar: e.profile.avatarUrl,
      avatarLabel: e.profile.name || e.profile.email,
      trailing: e.profile.email,
    },
  }));
}

/**
 * 按输入的字过滤:名字**或**邮箱命中即可,大小写不敏感。
 *
 * 空串 = 不过滤(刚打完 `@` 那一刻要看到全部好友,而不是一片空白)。
 */
export function searchFriendMentions(
  items: readonly FriendMentionItem[],
  query: string
): FriendMentionItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter(
    (i) =>
      i.label.toLowerCase().includes(q) || i.metadata.trailing.toLowerCase().includes(q)
  );
}
