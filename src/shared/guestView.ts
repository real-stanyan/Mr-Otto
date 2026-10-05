// 客人设备上收到的那一份事件（#1655，ADR-0372）。
//
// 客人 = 不是工作区成员、按会话名单进房的人（外联里那位朋友、主场群里的客人；判据是 CloudSession.isGuest）。
// #1655 起外联那一只也注入主人的团队 wiki 快照：快照落成一条 workspace_wiki_loaded，同一份正文还拼在
// request_envelope.system 的尾部——两条都随直播扇出与 backlog 下发到房里每一条连接，朋友手机上就有主人 wiki 的原文。
//
// 这里只裁**下发给客人的那一份**：日志本身一个字节不动（append-only 是唯一事实来源，裁的是投影）。
// 换成同 seq / ts / type 的空壳而不是整条丢掉：客户端按 seq 数缺口（cloudSessionClient 的 gapNote），
// 丢一条就会在客人界面上挂一句「有 N 条没收到」；两种事件在时间线里本来就不占行，空壳与原件画出来一样。
import type { SessionEvent } from "../session/events.js";

/** 给客人的那一份：wiki 快照清空正文、请求信封清空 system；别的事件原样（同一个对象，不复制）。不改入参 */
export function eventForGuest(e: SessionEvent): SessionEvent {
  if (e.type === "workspace_wiki_loaded") return { ...e, index: "", pinned: [], own: null, nudge: null };
  if (e.type === "request_envelope") return { ...e, system: "" };
  return e;
}
