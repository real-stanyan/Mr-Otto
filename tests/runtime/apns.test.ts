// apns —— 回电推送的纯层与发送编排（#1411，spec §1.3）。http2 注入假的；JWT 拿一对现生成的 P-256 钥匙验。
import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APNS_JWT_TTL_MS, apnsJwt, apnsVerdict, createApnsPusher, envOrder, ringHeaders, ringVoipPayload,
  type ApnsEnv, type ApnsReply, type PushDevice, type PushDeviceStore,
} from "../../services/runtime/src/apns.js";
import type { RingPush } from "../../src/shared/callRing.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const KEY = {
  keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  keyId: "KEY1234567",
  teamId: "HV982TTRNP",
  bundleId: "com.stanyan.mrotto.mobile",
};
const RING: RingPush = {
  ringId: "r1", workspaceId: "w1", sessionId: "s1", agentId: "ops", agentName: "运维",
  reason: "部署完了，要你拍板", chat: "dm", expiresTs: 1_700_000_045_000,
};
const part = (jwt: string, i: number): unknown => JSON.parse(Buffer.from(jwt.split(".")[i]!, "base64url").toString("utf8"));

describe("apnsJwt", () => {
  it("ES256、header 带 kid、claims 是 iss + iat（秒），公钥验得过", () => {
    const jwt = apnsJwt(KEY, 1_700_000_000_123);
    expect(part(jwt, 0)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(part(jwt, 1)).toEqual({ iss: "HV982TTRNP", iat: 1_700_000_000 });
    const [h, c, s] = jwt.split(".");
    const ok = createVerify("SHA256").update(`${h}.${c}`).verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(s!, "base64url"));
    expect(ok).toBe(true);
  });
});

describe("载荷与请求头", () => {
  it("载荷只有 ring：VoIP 推送不展示，界面由 CallKit 画（#1428）", () => {
    expect(ringVoipPayload(RING)).toEqual({ ring: RING });
  });
  it("头：voip、topic = bundle.voip、立即送、不存（过期的 VoIP 推送只会变成一通立刻挂掉的来电）、不合并", () => {
    expect(ringHeaders("com.stanyan.mrotto.mobile", "JWT")).toEqual({
      authorization: "bearer JWT",
      "apns-topic": "com.stanyan.mrotto.mobile.voip",
      "apns-push-type": "voip",
      "apns-priority": "10",
      "apns-expiration": "0",
    });
  });
});

describe("apnsVerdict / envOrder", () => {
  it("200 送到；410 作废；400 BadDeviceToken 换环境；别的错不怪令牌", () => {
    expect(apnsVerdict({ status: 200, reason: null })).toBe("ok");
    expect(apnsVerdict({ status: 410, reason: "Unregistered" })).toBe("dead");
    expect(apnsVerdict({ status: 400, reason: "BadDeviceToken" })).toBe("other_env");
    expect(apnsVerdict({ status: 400, reason: "DeviceTokenNotForTopic" })).toBe("error");
    expect(apnsVerdict({ status: 403, reason: "ExpiredProviderToken" })).toBe("error");
    expect(apnsVerdict({ status: 500, reason: null })).toBe("error");
  });
  it("记过的环境先试；没记过先生产", () => {
    expect(envOrder(null)).toEqual(["production", "sandbox"]);
    expect(envOrder("production")).toEqual(["production", "sandbox"]);
    expect(envOrder("sandbox")).toEqual(["sandbox", "production"]);
  });
});

function fakeStore(devices: PushDevice[]): PushDeviceStore & { envs: [string, ApnsEnv][]; removed: string[] } {
  const envs: [string, ApnsEnv][] = [];
  const removed: string[] = [];
  return {
    envs,
    removed,
    list: async () => devices,
    setEnv: async (token, env) => { envs.push([token, env]); },
    remove: async (token) => { removed.push(token); },
  };
}

/** 按「环境:令牌」回一份预设的回复（没预设的回 500），记下每一次请求 */
function fakeRequest(replies: Record<string, ApnsReply>) {
  const calls: { env: ApnsEnv; path: string; headers: Record<string, string>; body: string }[] = [];
  const request = async (env: ApnsEnv, path: string, headers: Record<string, string>, body: string): Promise<ApnsReply> => {
    calls.push({ env, path, headers, body });
    return replies[`${env}:${path.replace("/3/device/", "")}`] ?? { status: 500, reason: null };
  };
  return { calls, request };
}

describe("createApnsPusher", () => {
  it("记过环境、一发就中：送到 1 台，不回写", async () => {
    const store = fakeStore([{ token: "aa", env: "production" }]);
    const f = fakeRequest({ "production:aa": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.path).toBe("/3/device/aa");
    expect(JSON.parse(f.calls[0]!.body)).toEqual(ringVoipPayload(RING));
    expect(f.calls[0]!.headers["apns-topic"]).toBe("com.stanyan.mrotto.mobile.voip");
    expect(store.envs).toEqual([]);
  });
  it("没记过：生产说不认识 → 沙盒送到，回写 sandbox", async () => {
    const store = fakeStore([{ token: "bb", env: null }]);
    const f = fakeRequest({ "production:bb": { status: 400, reason: "BadDeviceToken" }, "sandbox:bb": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(f.calls.map((c) => c.env)).toEqual(["production", "sandbox"]);
    expect(store.envs).toEqual([["bb", "sandbox"]]);
  });
  it("两个环境都不认识 / 410：删掉这个令牌", async () => {
    const store = fakeStore([{ token: "cc", env: null }, { token: "dd", env: "sandbox" }]);
    const f = fakeRequest({
      "production:cc": { status: 400, reason: "BadDeviceToken" },
      "sandbox:cc": { status: 400, reason: "BadDeviceToken" },
      "sandbox:dd": { status: 410, reason: "Unregistered" },
    });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(0);
    expect([...store.removed].sort()).toEqual(["cc", "dd"]);
  });
  it("别的错（5xx / 连接断了）：不删令牌，这一台算没送到", async () => {
    const store = fakeStore([{ token: "ee", env: "production" }, { token: "ff", env: "production" }]);
    const p = createApnsPusher({
      key: KEY, devices: store, log: () => {},
      request: async (_env, path) => {
        if (path.endsWith("ee")) return { status: 503, reason: "ServiceUnavailable" };
        throw new Error("socket hang up");
      },
    });
    expect(await p.pushRing("u1", RING)).toBe(0);
    expect(store.removed).toEqual([]);
  });
  it("一台送到一台作废：回 1", async () => {
    const store = fakeStore([{ token: "g1", env: "production" }, { token: "g2", env: "production" }]);
    const f = fakeRequest({ "production:g1": { status: 200, reason: null }, "production:g2": { status: 410, reason: "Unregistered" } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, log: () => {} });
    expect(await p.pushRing("u1", RING)).toBe(1);
    expect(store.removed).toEqual(["g2"]);
  });
  it("JWT 50 分钟内复用，到点换一张", async () => {
    let t = 1_700_000_000_000;
    const store = fakeStore([{ token: "hh", env: "production" }]);
    const f = fakeRequest({ "production:hh": { status: 200, reason: null } });
    const p = createApnsPusher({ key: KEY, devices: store, request: f.request, now: () => t, log: () => {} });
    await p.pushRing("u1", RING);
    t += APNS_JWT_TTL_MS - 1;
    await p.pushRing("u1", RING);
    t += 2;
    await p.pushRing("u1", RING);
    const auths = f.calls.map((c) => c.headers.authorization);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[2]).not.toBe(auths[1]);
  });
  it("deviceCount：这个人登记了几台", async () => {
    const p = createApnsPusher({
      key: KEY, devices: fakeStore([{ token: "a", env: null }, { token: "b", env: null }]),
      request: async () => ({ status: 200, reason: null }), log: () => {},
    });
    expect(await p.deviceCount("u1")).toBe(2);
  });
});
