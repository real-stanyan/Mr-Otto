// apns —— 回电的推送：runtime 直发 APNs（#1411，spec §1.3，ADR-0331）。
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

export type ApnsEnv = "production" | "sandbox";
export const APNS_HOSTS: Record<ApnsEnv, string> = { production: "api.push.apple.com", sandbox: "api.sandbox.push.apple.com" };
/** JWT 多久换一次：APNs 要求不超过 1 小时，也不许换得太勤（spec §1.3） */
export const APNS_JWT_TTL_MS = 50 * 60_000;
/** 锁屏铃声的文件名（mobile/assets/sounds/，由 expo-notifications 插件打进包里） */
export const RING_SOUND = "ringtone.caf";

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

/** 一通来电的推送：标题「名字 来电」、正文是它要说的那句话、30 秒铃声、时效性通知（专注模式里也响）、
    按会话归组。`ring` 那一格给手机开来电页用 */
export function ringNotification(ring: RingPush): { aps: Record<string, unknown>; ring: RingPush } {
  return {
    aps: {
      alert: { title: `${ring.agentName} 来电`, body: ring.reason },
      sound: RING_SOUND,
      "interruption-level": "time-sensitive",
      "thread-id": ring.sessionId,
    },
    ring,
  };
}

/** 请求头。`apns-expiration` 是响铃过期那一刻（秒）：过了还没送到的，APNs 不再送 */
export function ringHeaders(ring: RingPush, bundleId: string, jwt: string): Record<string, string> {
  return {
    authorization: `bearer ${jwt}`,
    "apns-topic": bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(Math.floor(ring.expiresTs / 1000)),
    "apns-collapse-id": ring.ringId,
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
export interface PushDeviceStore {
  list(uid: string): Promise<PushDevice[]>;
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

  async function sendOne(device: PushDevice, ring: RingPush): Promise<DeviceOutcome> {
    const body = JSON.stringify(ringNotification(ring));
    for (const env of envOrder(device.env)) {
      let reply: ApnsReply;
      try {
        reply = await request(env, `/3/device/${device.token}`, ringHeaders(ring, o.key.bundleId, tokenNow()), body);
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
      return (await o.devices.list(uid)).length;
    },
    async pushRing(uid, ring) {
      const devices = await o.devices.list(uid);
      const outcomes = await Promise.all(devices.map((d) => sendOne(d, ring)));
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
