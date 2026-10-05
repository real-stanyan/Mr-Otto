// 手机端的云会话客户端（#1356 A1，spec §3.2）：A0 把桌面那份挪进了 shared，这里只接线——
// 传输是中继上的 WebSocket（role 必须是 guest：runtime 在 cs 房里是 host，中继只配对
// host↔guest），令牌现取 supabase 的 session（会过期，缓存一份等于把「过期」变成一次静默失联），
// 推送交给 chatStore。个人主场里一张审批卡都不出（ADR-0298），审批那三个钩子接空。
//
// App 回到前台时对当前会话房 reconnectNow：iOS 把后台 app 的 socket 掐了之后，退避重连
// 可能还要等好几秒，人一回来就该立刻换一条。切到后台时反过来主动断开（#1411）：后台 = 不在看，
// runtime 据「房里有没有他的连接」决定回电打不打，挂起的 socket 在服务端看来却还连着。
// 例外：系统来电进行中不暂停（锁着屏通话靠这条连接，#1428，systemCall.ts）。
import { AppState } from "react-native";
import { answerHealthQuery } from "../../../src/shared/health.js";
import { csCtlChannel } from "../../../src/shared/remote/cloudSession.js";
import { createCloudSessionClient, type CloudSessionClient } from "../../../src/shared/remote/cloudSessionClient.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import type { CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { inSystemCall, onSystemCallEnded } from "../call/systemCall.js";
import { healthEnabled, onHealthPrefChange, readHealth } from "../health/healthPrefs.js";
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
let room: ReturnType<typeof createWsTransport> | null = null;
let sinks: CloudSinks | null = null;

export const cloudClient: CloudSessionClient = createCloudSessionClient({
  accessToken,
  selfUid: () => uid,
  // 设备时区（#1283）：每句话带上，runtime 落到 user_message.tz，模型投影的「今天是」才按人在的地方算
  deviceTz: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  // Apple 健康（#1656）：开着才声明能力；runtime 来问时开关再判一次（问的那一刻可能刚关）
  deviceCaps: () => ({ health: healthEnabled() }),
  onHealthQuery: (q) => answerHealthQuery(q, { enabled: healthEnabled, read: readHealth }),
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
  // 已经关掉的传输（leave 之后）reconnectNow / pause 都是空操作
  if (s === "active") room?.reconnectNow("回到前台");
  else if (s === "background" && !inSystemCall()) room?.pause("切到后台");
});

// 系统来电期间切后台不暂停会话房（#1428）：锁着屏通话靠它；来电结束时还在后台就补暂停——runtime 据「房里有没有
// 他的连接」决定下一通回电打不打（ADR-0331）
onSystemCallEnded(() => {
  if (AppState.currentState !== "active") room?.pause("系统来电结束、在后台");
});

// 开关变了当场告诉 runtime（#1656）：不然要等下次进房 welcome 才更新，关掉之后那段时间它还会来问
onHealthPrefChange(() => cloudClient.refreshCaps());
