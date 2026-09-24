// 手机端的云会话客户端（#1356 A1，spec §3.2）：A0 把桌面那份挪进了 shared，这里只接线——
// 传输是中继上的 WebSocket（role 必须是 guest：runtime 在 cs 房里是 host，中继只配对
// host↔guest），令牌现取 supabase 的 session（会过期，缓存一份等于把「过期」变成一次静默失联），
// 推送交给 chatStore。个人主场里一张审批卡都不出（ADR-0298），审批那三个钩子接空。
//
// App 回到前台时对当前会话房 reconnectNow：iOS 把后台 app 的 socket 掐了之后，退避重连
// 可能还要等好几秒，人一回来就该立刻换一条。
import { AppState } from "react-native";
import { csCtlChannel } from "../../../src/shared/remote/cloudSession.js";
import { createCloudSessionClient, type CloudSessionClient } from "../../../src/shared/remote/cloudSessionClient.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import type { CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";

export interface CloudSinks {
  event(e: SessionEvent): void;
  status(s: CloudSessionStatus): void;
  delta(d: CloudSessionDelta): void;
}

/** 客户端要同步读 uid（selfUid 不是 async）。冷启动时 getSession 还没回来，开会话前
    先 `ensureUid()` 等一次 */
let uid: string | null = null;
void supabase.auth.getSession().then(({ data }) => {
  uid = data.session?.user.id ?? null;
});
supabase.auth.onAuthStateChange((_event, session) => {
  uid = session?.user.id ?? null;
});

const accessToken = async (): Promise<string | null> =>
  (await supabase.auth.getSession()).data.session?.access_token ?? null;

/** 当前会话房那条传输（控制房每个请求一条、拿到回执就关，不记） */
let room: RemoteTransport | null = null;
let sinks: CloudSinks | null = null;

export const cloudClient: CloudSessionClient = createCloudSessionClient({
  accessToken,
  selfUid: () => uid,
  createTransport: (channel) => {
    const t = createWsTransport({
      baseUrl: RELAY_BASE,
      role: "guest",
      channel,
      authToken: accessToken,
      log: (m) => console.warn(m),
    });
    if (channel !== csCtlChannel()) room = t;
    return t;
  },
  sendEvent: (e) => sinks?.event(e),
  sendStatus: (s) => sinks?.status(s),
  sendDelta: (d) => sinks?.delta(d),
  onApprovalRequest: () => {},
  onApprovalDecision: () => {},
  onSessionInactive: () => {},
  log: (m) => console.warn(m),
});

export function setCloudSinks(s: CloudSinks): void {
  sinks = s;
}

export async function ensureUid(): Promise<string | null> {
  if (uid !== null) return uid;
  uid = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  return uid;
}

AppState.addEventListener("change", (s) => {
  // 已经关掉的传输（leave 之后）reconnectNow 是空操作
  if (s === "active") room?.reconnectNow("回到前台");
});
