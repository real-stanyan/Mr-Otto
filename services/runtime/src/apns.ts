// apns —— runtime 直发 APNs。两种推送共用一条连接、一张令牌表、一套环境探测：
// · 回电：VoIP 推送（#1411 → #1428，ADR-0331 / ADR-0335）。普通通知会被 iOS 路由到正在用的设备（开着
//   iPhone 镜像的 Mac、手表），保证不了在手机上响；VoIP 推送叫起 App、由 CallKit 画系统来电。
// · 消息：普通通知（#1442）。智能体回答 / 有人 @ 我 / 朋友消息。发给 kind='alert' 的令牌；
//   推不推（开关、免打扰）由 notifier.ts 判，这一层只管发。
//
// 分两层（同 config.ts 的纯核心 + 薄壳）：
// · 纯的：JWT 的形状与签名、请求头与载荷、一次回复算什么（送到 / 令牌作废 / 换个环境再试 / 别的错）、
//   一台设备按什么顺序试环境、发送编排——这些进 vitest；
// · IO：node:http2 的长连接（每个主机一条，断了下次用时重连）。测试注入假的 `request`。
//
// 为什么要试两个环境：从 Xcode 装的包的令牌只有沙盒认，TestFlight / App Store 的只有生产认，手机自己
// 分不出是哪一种。所以先按那一行记下的 `apns_env` 发；没记过的先试生产，回 400 BadDeviceToken 再试沙盒，
// 送到了把环境回写。两边都 BadDeviceToken，或者回 410 Unregistered，这个令牌就删掉。

import { createSign } from "node:crypto";
import { connect, type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import type { RingPush } from "../../../src/shared/callRing.js";
import { alertPayload, type AlertPush } from "../../../src/shared/notifyPrefs.js";

export type ApnsEnv = "production" | "sandbox";
export const APNS_HOSTS: Record<ApnsEnv, string> = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
/** JWT 多久换一次：APNs 要求不超过 1 小时，也不许换得太勤（spec §1.3） */
export const APNS_JWT_TTL_MS = 50 * 60_000;

export interface ApnsKey {
  keyPem: string;
  keyId: string;
  teamId: string;
  bundleId: string;
}

const b64url = (b: Buffer | string): string => Buffer.from(b).toString("base64url");

/** ES256 的 provider token：header `{alg, kid}`、claims `{iss: teamId, iat}`（秒）。签名要 IEEE P1363
    格式（r‖s 各 32 字节），node 默认给的是 DER，APNs 不认 */
export function apnsJwt(key: Pick<ApnsKey, "keyPem" | "keyId" | "teamId">, nowMs: number): string {
  const head = b64url(JSON.stringify({ alg: "ES256", kid: key.keyId }));
  const claims = b64url(JSON.stringify({ iss: key.teamId, iat: Math.floor(nowMs / 1000) }));
  const input = `${head}.${claims}`;
  const sig = createSign("SHA256").update(input).sign({ key: key.keyPem, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64url(sig)}`;
}

/** VoIP 推送的载荷：只有 ring。VoIP 推送不展示（没有 aps），手机的 otto-call 收到后当场报给 CallKit，
    系统来电界面上的名字取 ring.agentName */
export function ringVoipPayload(ring: RingPush): { ring: RingPush } {
  return { ring };
}

/** 请求头。topic 是 `<bundle>.voip`（VoIP 推送的规矩）；`apns-expiration: 0` = 送不到就作废：过了时限才到的
    VoIP 推送手机也必须报来电（iOS 13 起的硬规定），只会变成一通立刻挂掉的来电。VoIP 推送不支持合并，不带
    collapse-id */
export function ringHeaders(bundleId: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": `${bundleId}.voip`,
    "apns-push-type": "voip",
    "apns-priority": "10",
    "apns-expiration": "0",
  };
}

/** 普通通知的请求头。topic 就是 bundle（不带 .voip）；送不到的通知 APNs 存着、手机连上再送（一天封顶，
    过期的消息没必要半夜补到）；collapse-id 不带：同一条聊天的几条通知各自是一条消息，不该互相覆盖 */
export function alertHeaders(bundleId: string, jwt: string, nowMs: number): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(nowMs / 1000) + 24 * 3600),
  };
}

export interface ApnsReply {
  status: number;
  reason: string | null;
}
export type ApnsVerdict = "ok" | "other_env" | "dead" | "error";

/** 一次回复算什么：200 送到了；410 Unregistered = 这个令牌作废；400 BadDeviceToken = 这个令牌不属于
    这个环境（换一个试）；其余（403 令牌过期、429、5xx…）是我们这边或 APNs 的事，不怪令牌、不删 */
export function apnsVerdict(r: ApnsReply): ApnsVerdict {
  if (r.status === 200) return "ok";
  if (r.status === 410) return "dead";
  if (r.status === 400 && r.reason === "BadDeviceToken") return "other_env";
  return "error";
}

/** 这台设备按什么顺序试环境：记过的先试，没记过的先生产；另一个环境永远排第二 */
export function envOrder(recorded: ApnsEnv | null): [ApnsEnv, ApnsEnv] {
  return recorded === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];
}

export interface PushDevice {
  token: string;
  env: ApnsEnv | null;
}

/** 令牌表那一侧（daemon 接 Supabase，测试接内存） */
export type PushKind = "voip" | "alert";

export interface PushDeviceStore {
  list(uid: string, kind: PushKind): Promise<PushDevice[]>;
  setEnv(token: string, env: ApnsEnv): Promise<void>;
  remove(token: string): Promise<void>;
}

/** 发一个请求：`path` 形如 `/3/device/<token>`。真的那层是 http2Request，测试给假的 */
export type ApnsRequest = (env: ApnsEnv, path: string, headers: Record<string, string>, body: string) => Promise<ApnsReply>;

type DeviceOutcome = "delivered" | "dead" | "failed";

export interface ApnsPusher {
  /** 给这个人的每一台设备推一次来电，回送到了几台。令牌表的维护（回写环境、删作废的令牌）顺手做 */
  pushRing(uid: string, ring: RingPush): Promise<number>;
  /** 这个人登记了几台设备（打之前问：一台都没有就不落 ringing）。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
  /** 给这个人每一台登记了普通通知的设备推一条消息，回送到了几台。读令牌表失败往上抛 */
  pushAlert(uid: string, push: AlertPush): Promise<number>;
}

export function createApnsPusher(o: {
  key: ApnsKey;
  devices: PushDeviceStore;
  request?: ApnsRequest;
  now?: () => number;
  log: (m: string) => void;
}): ApnsPusher {
  const request = o.request ?? http2Request();
  const now = o.now ?? (() => Date.now());
  let jwt: { token: string; at: number } | null = null;
  const tokenNow = (): string => {
    const t = now();
    if (jwt === null || t - jwt.at >= APNS_JWT_TTL_MS) jwt = { token: apnsJwt(o.key, t), at: t };
    return jwt.token;
  };

  async function sendOne(device: PushDevice, body: string, headers: () => Record<string, string>): Promise<DeviceOutcome> {
    for (const env of envOrder(device.env)) {
      let reply: ApnsReply;
      try {
        reply = await request(env, `/3/device/${device.token}`, headers(), body);
      } catch (err) {
        o.log(`[otto-runtime] APNs 请求失败（${env}）：${err instanceof Error ? err.message : String(err)}`);
        return "failed";
      }
      const v = apnsVerdict(reply);
      if (v === "ok") {
        if (device.env !== env) await o.devices.setEnv(device.token, env).catch(() => undefined);
        return "delivered";
      }
      if (v === "dead") {
        await o.devices.remove(device.token).catch(() => undefined);
        return "dead";
      }
      if (v === "error") {
        o.log(`[otto-runtime] APNs 拒了这次推送（${env}）：${reply.status} ${reply.reason ?? ""}`);
        return "failed";
      }
      // other_env：换另一个环境再试
    }
    // 两个环境都说不认识这个令牌
    await o.devices.remove(device.token).catch(() => undefined);
    return "dead";
  }

  return {
    async deviceCount(uid) {
      return (await o.devices.list(uid, "voip")).length;
    },
    async pushRing(uid, ring) {
      const devices = await o.devices.list(uid, "voip");
      const body = JSON.stringify(ringVoipPayload(ring));
      const outcomes = await Promise.all(devices.map((d) => sendOne(d, body, () => ringHeaders(o.key.bundleId, tokenNow()))));
      return outcomes.filter((x) => x === "delivered").length;
    },
    async pushAlert(uid, push) {
      const devices = await o.devices.list(uid, "alert");
      const body = JSON.stringify(alertPayload(push));
      const outcomes = await Promise.all(devices.map((d) => sendOne(d, body, () => alertHeaders(o.key.bundleId, tokenNow(), now()))));
      return outcomes.filter((x) => x === "delivered").length;
    },
  };
}

/** 真的那一层：每个主机一条 http2 长连接，断了（error / close / goaway）下次用时重连。10 秒没回当失败 */
export function http2Request(): ApnsRequest {
  const sessions = new Map<ApnsEnv, ClientHttp2Session>();
  const sessionFor = (env: ApnsEnv): ClientHttp2Session => {
    const live = sessions.get(env);
    if (live !== undefined && !live.closed && !live.destroyed) return live;
    const fresh = connect(`https://${APNS_HOSTS[env]}`);
    const drop = (): void => {
      if (sessions.get(env) === fresh) sessions.delete(env);
    };
    fresh.on("error", drop);
    fresh.on("close", drop);
    fresh.on("goaway", drop);
    sessions.set(env, fresh);
    return fresh;
  };
  return (env, path, headers, body) =>
    new Promise<ApnsReply>((resolve, reject) => {
      let req: ClientHttp2Stream;
      try {
        req = sessionFor(env).request({ ":method": "POST", ":path": path, "content-type": "application/json", ...headers });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let status = 0;
      let data = "";
      req.setEncoding("utf8");
      req.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
      });
      req.on("data", (chunk: string) => {
        data += chunk;
      });
      req.on("end", () => {
        let reason: string | null = null;
        try {
          reason = (JSON.parse(data) as { reason?: string }).reason ?? null;
        } catch {
          // 200 没有 body
        }
        resolve({ status, reason });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => {
        req.close();
        reject(new Error("APNs 10 秒没回"));
      });
      req.end(body);
    });
}
