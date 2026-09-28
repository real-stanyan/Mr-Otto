// 群里的客人（#1393，ADR-0325）：群主之外、被拉进主场群聊的真人。daemon.ts 一 import 就要连
// docker / Supabase，进不了 vitest，所以「查谁是朋友」「改名单那一刀让不让过」「表要增删哪几行」
// 这几个判断住在这儿、接线留在那儿（同 chatCreate.ts 的做法）。
import { humanRosterChangeProblem, USER_UID_RE, type ChatHuman } from "../../../src/shared/chatRoster.js";

/** 「uid 与这几个人里哪几个是朋友」的 PostgREST 过滤串。**只拼校验过的 uid**：候选名单来自线上，
    不是 uuid 形状的直接丢掉（协议那一层已经拒过一次，这里是第二道——拼进查询串的东西不能只靠上游） */
export function friendshipFilter(uid: string, candidates: readonly string[]): string | null {
  const ok = candidates.filter((c) => USER_UID_RE.test(c) && c !== uid);
  if (!USER_UID_RE.test(uid) || ok.length === 0) return null;
  const list = ok.join(",");
  return `and(requester.eq.${uid},addressee.in.(${list})),and(addressee.eq.${uid},requester.in.(${list}))`;
}

/** 查回来的 accepted 好友行 → 对方的 uid 集合 */
export function friendSetOf(uid: string, rows: readonly { requester: string; addressee: string }[]): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.requester === uid) out.add(r.addressee);
    else if (r.addressee === uid) out.add(r.requester);
  }
  return out;
}

export type HumansChange =
  | { ok: true; next: ChatHuman[]; added: string[]; removed: string[] }
  | { ok: false; message: string };

/** 改客人名单的这一刀（chat_update 带 humans）：让不让过、过了之后名单长什么样。
    名字：留下的人沿用日志里那份快照（改名不改史），新来的现取（`nameOf`）。
    `friendsOfActor` 只需要覆盖**新来的**那几个——拉进来的人必须是动手那个人的朋友 */
export function planHumansChange(o: {
  actorUid: string;
  actorIsOwner: boolean;
  ownerUid: string;
  before: readonly ChatHuman[];
  after: readonly string[];
  friendsOfActor: ReadonlySet<string>;
  nameOf: (uid: string) => string;
}): HumansChange {
  const problem = humanRosterChangeProblem({
    actorUid: o.actorUid,
    actorIsOwner: o.actorIsOwner,
    ownerUid: o.ownerUid,
    before: o.before.map((h) => h.uid),
    after: o.after,
    friendsOfActor: o.friendsOfActor,
  });
  if (problem !== null) return { ok: false, message: problem };
  const kept = new Map(o.before.map((h) => [h.uid, h] as const));
  const next = o.after.map((uid) => kept.get(uid) ?? { uid, name: o.nameOf(uid) });
  const beforeSet = new Set(o.before.map((h) => h.uid));
  const afterSet = new Set(o.after);
  return {
    ok: true,
    next,
    added: o.after.filter((u) => !beforeSet.has(u)),
    removed: o.before.map((h) => h.uid).filter((u) => !afterSet.has(u)),
  };
}

/** 建群那一刻的客人：必须都是建群人的朋友、不能是他自己。回 null = 可以；字符串 = 不可以的那句人话 */
export function createHumansProblem(o: {
  creatorUid: string;
  humans: readonly string[];
  friendsOfCreator: ReadonlySet<string>;
  home: boolean;
}): string | null {
  if (o.humans.length === 0) return null;
  // 团队有自己的成员名单（工作区一级），往团队的群里另塞人是另一套权限，这里不开这个口
  if (!o.home) return "团队里的群聊拉人走团队成员。";
  if (o.humans.includes(o.creatorUid)) return "你本来就在群里。";
  if (o.humans.some((u) => !o.friendsOfCreator.has(u))) return "只能拉你的朋友进群。";
  return null;
}
