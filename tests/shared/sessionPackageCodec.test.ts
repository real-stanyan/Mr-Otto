import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { packSession } from "../../src/shared/sessionPackage.js";
import {
  ATTACH_DIR,
  decodeEnvelope,
  decodePackage,
  encodeEnvelope,
  encodePackage,
  EVENTS_FILE,
  MANIFEST_FILE,
  packageKeys,
} from "../../src/shared/sessionPackageCodec.js";

// 会话包线上格式编解码 + DM 信封（issue #611，PR#2）。纯函数，无真 Supabase。

let ts = 0;
function ev(e: { type: SessionEvent["type"] } & Record<string, unknown>): SessionEvent {
  return { seq: -1, sessionId: "src", ts: ++ts, ...e } as unknown as SessionEvent;
}

function samplePkg() {
  return packSession({
    events: [
      ev({ type: "session_created", title: "源会话", workspace: "/Users/stan/x" }),
      ev({ type: "user_message", content: "看这个", attachments: [{ id: "sha256:aa", mediaType: "image/png", bytes: 3 }] }),
      ev({ type: "assistant_message", content: "好", model: "m" }),
      ev({ type: "turn_ended", outcome: "completed" }),
    ],
    message: "继续查",
    title: "源会话",
    model: "m",
    exportedTs: 42,
    attachmentBytes: { "sha256:aa": new Uint8Array([9, 8, 7]) },
  });
}

describe("encodePackage / decodePackage（线上格式，JSONL + 附件分开）", () => {
  it("编成 manifest.json + events.jsonl + attachments/<hex>", () => {
    const files = encodePackage(samplePkg());
    const names = [...files.keys()];
    expect(names).toContain(MANIFEST_FILE);
    expect(names).toContain(EVENTS_FILE);
    expect(names).toContain(`${ATTACH_DIR}aa`); // hex 部分，无 sha256: 前缀
    // 附件字节原样（不 base64）——体积不涨
    expect(files.get(`${ATTACH_DIR}aa`)).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("往返：编了再解回来，包内容不变", () => {
    const original = samplePkg();
    const files = encodePackage(original);
    const out = decodePackage(files);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.pkg.manifest.message).toBe("继续查");
    expect(out.pkg.events.map((e) => e.type)).toEqual(original.events.map((e) => e.type));
    expect(out.pkg.attachmentBytes["sha256:aa"]).toEqual(new Uint8Array([9, 8, 7]));
  });

  it("缺文件 / 坏 JSON 返回错误，不抛", () => {
    expect(decodePackage(new Map()).ok).toBe(false); // 空
    const noManifest = new Map([[EVENTS_FILE, new TextEncoder().encode("{}\n")]]);
    expect(decodePackage(noManifest).ok).toBe(false);

    const badEvents = new Map([
      [MANIFEST_FILE, new TextEncoder().encode(JSON.stringify(samplePkg().manifest))],
      [EVENTS_FILE, new TextEncoder().encode("{不是json\n")],
    ]);
    const r = decodePackage(badEvents);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes("events.jsonl"))).toBe(true);
  });

  it("解出来还要过 validatePackage 那道结构门", () => {
    // 构造一个 eventCount 不自洽的包
    const pkg = samplePkg();
    (pkg.manifest as { eventCount: number }).eventCount = 999;
    const files = encodePackage(pkg);
    const out = decodePackage(files);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.some((e) => e.includes("不自洽"))).toBe(true);
  });
});

describe("packageKeys（Storage 对象键）", () => {
  it("所有文件共享 senderUid/pkgId 前缀", () => {
    const keys = packageKeys("uid-1/pkg-9", samplePkg());
    for (const k of keys.keys()) expect(k.startsWith("uid-1/pkg-9/")).toBe(true);
    expect([...keys.keys()]).toContain("uid-1/pkg-9/manifest.json");
  });
});

describe("DM 信封（encodeEnvelope / decodeEnvelope）", () => {
  const env = {
    bucket: "session-packages",
    prefix: "uid-1/pkg-9",
    message: "帮我继续查这个 bug",
    title: "源会话",
    eventCount: 4,
  };

  it("往返：编了再解回来不变", () => {
    const body = encodeEnvelope(env);
    const out = decodeEnvelope(body);
    expect(out).not.toBeNull();
    expect(out?.prefix).toBe("uid-1/pkg-9");
    expect(out?.message).toBe("帮我继续查这个 bug");
    expect(out?.eventCount).toBe(4);
  });

  it("普通私信（非 JSON / 无标记）返回 null，不误认", () => {
    expect(decodeEnvelope("晚上吃啥")).toBeNull();
    expect(decodeEnvelope('{"foo":1}')).toBeNull();
    expect(decodeEnvelope('{"otto":"别的","v":1}')).toBeNull();
  });

  it("信封整个占用 body——一小段 JSON，远在 4000 字符限内", () => {
    const body = encodeEnvelope(env);
    expect(body.length).toBeLessThan(4000);
    expect(() => JSON.parse(body)).not.toThrow();
  });

  // ─── 连带授权那两个字段（issue #694，ADR-0177）────────────────────
  const INVITE = "otto-proxy:1:host-uid:chan-1:cHVi:c2Vj:1700000000000";

  it("带上邀请码与服务清单也往返得回来", () => {
    const out = decodeEnvelope(encodeEnvelope({ ...env, grantServers: ["shopify"], invite: INVITE }));
    expect(out?.grantServers).toEqual(["shopify"]);
    expect(out?.invite).toBe(INVITE);
    // 加了这两个字段仍然远在 DM 的 4000 字符限内（邀请码是定长的七段）
    expect(encodeEnvelope({ ...env, grantServers: ["shopify"], invite: INVITE }).length).toBeLessThan(4000);
  });

  it("老信封（没有这两个字段）照常解得开，且不凭空长出它们", () => {
    const out = decodeEnvelope(encodeEnvelope(env));
    expect(out).not.toBeNull();
    expect(out?.invite).toBeUndefined();
    expect(out?.grantServers).toBeUndefined();
  });

  it("版本仍然是 1 —— 涨版本会让老客户端把整条私信判成不认识", () => {
    const body = encodeEnvelope({ ...env, invite: INVITE });
    expect((JSON.parse(body) as { v: number }).v).toBe(1);
  });

  it("字段形状不对就当没有：信封来自网络，一律先验再用", () => {
    const bad = JSON.stringify({
      otto: "otto.session-share", v: 1, bucket: "b", prefix: "p",
      grantServers: [1, "shopify", null], invite: 42,
    });
    const out = decodeEnvelope(bad);
    expect(out?.grantServers).toEqual(["shopify"]); // 非字符串项剔掉，不是整条丢弃
    expect(out?.invite).toBeUndefined(); // 不是字符串 = 没有邀请码，卡片不给按钮
  });

  it("空邀请码不算邀请码 —— 否则卡片会给出一个点了必然失败的按钮", () => {
    const out = decodeEnvelope(encodeEnvelope({ ...env, invite: "" }));
    expect(out?.invite).toBeUndefined();
  });
});
