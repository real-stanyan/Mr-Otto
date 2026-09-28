// 挑人那张单子上「朋友」那一段的数据（#1393）：我的朋友（已通过的），去掉此刻已经在群里的人。
// 按名字排（同通讯录）。只挑得到**我自己**的朋友——服务端也只认这个（拉进群的必须是动手那个人的朋友）。
import { friendName, sortFriends } from "../../../src/shared/wechatInbox.js";
import type { FriendRow } from "../friends/friendsApi.js";
import type { PickPerson } from "./PickAgentsDialog.js";

export function friendPeople(rows: readonly FriendRow[] | null, exclude: ReadonlySet<string>): PickPerson[] {
  const accepted = (rows ?? []).filter((r) => r.status === "accepted" && !exclude.has(r.profile.id));
  return sortFriends(accepted).map((r) => ({ uid: r.profile.id, name: friendName(r.profile), url: r.profile.avatarUrl }));
}
