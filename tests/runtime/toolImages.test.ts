// 云会话里工具产出的图（#1682 出图，toolImages.ts）：落附件库 + 传进 chat-media 的这条会话目录；
// 哪一张传不上去就跳过哪一张，不炸工具调用；出图走哪条路（订阅 / 额度 / 网关供不供，四种措辞分开）。
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore } from "../../src/session/attachments.js";
import type { ToolCallContext, ToolOutcome } from "../../src/loop/middleware.js";
import type { BillingMe } from "../../src/shared/billing.js";
import { ON_BEHALF_HEADER, SESSION_HEADER, WORKSPACE_HEADER, AGENT_HEADER } from "../../src/shared/billing.js";
import { CHAT_MEDIA_BUCKET } from "../../src/shared/chatMedia.js";
import {
  createToolImageIntakeMiddleware, decideRuntimeImageRoute, imageSizeOf, RUNTIME_IMAGE_MODEL, type MediaUpload,
} from "../../services/runtime/src/toolImages.js";
import { tempDir } from "../helpers/tempDir.js";

/** 1×1 的真 PNG */
const PNG = new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
/** 头上一个 SOF0（高 16、宽 32）的 JPEG 片段：只够 imageSizeOf 读、够附件库认 */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0x01, 0x22, 0x00]);
const hexOf = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

const WS = "11111111-1111-4111-8111-111111111111";
const SID = "22222222-2222-4222-8222-222222222222";

let dir: string;
beforeEach(() => { dir = tempDir("otto-tool-images-"); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const ctx = { call: { id: "c1", name: "generate_image", args: {} }, tool: undefined, world: {} as ToolCallContext["world"], sessionId: SID } as ToolCallContext;

function rig(fail: (path: string) => boolean = () => false) {
  const uploads: { bucket: string; path: string; contentType: string; bytes: number }[] = [];
  const upload: MediaUpload = async (bucket, path, data, contentType) => {
    if (fail(path)) throw new Error("boom");
    uploads.push({ bucket, path, contentType, bytes: data.byteLength });
  };
  const store = new AttachmentStore(dir);
  const mw = createToolImageIntakeMiddleware({ store, upload }, { workspaceId: WS, sessionId: SID });
  return { uploads, store, mw };
}

describe("createToolImageIntakeMiddleware", () => {
  it("工具交的图：落附件库、传进 chat-media/<团队>/<会话>/<sha256>.<ext>，回带宽高的 ref；output 一个字不动", async () => {
    const { uploads, store, mw } = rig();
    const out = await mw(ctx, async (): Promise<ToolOutcome> => ({ status: "ok", output: "已生成 2 张图", images: [{ data: PNG, mimeType: "image/png" }, { data: JPEG, mimeType: "image/jpeg" }] }));
    expect(out.output).toBe("已生成 2 张图");
    expect(uploads).toEqual([
      { bucket: CHAT_MEDIA_BUCKET, path: `${WS}/${SID}/${hexOf(PNG)}.png`, contentType: "image/png", bytes: PNG.byteLength },
      { bucket: CHAT_MEDIA_BUCKET, path: `${WS}/${SID}/${hexOf(JPEG)}.jpg`, contentType: "image/jpeg", bytes: JPEG.byteLength },
    ]);
    expect(out.imageRefs).toEqual([
      { id: `sha256:${hexOf(PNG)}`, mediaType: "image/png", bytes: PNG.byteLength, name: "generate_image.png", width: 1, height: 1 },
      { id: `sha256:${hexOf(JPEG)}`, mediaType: "image/jpeg", bytes: JPEG.byteLength, name: "generate_image.jpg", width: 32, height: 16 },
    ]);
    // 附件库里那份读得回来（图生图 edit_last 从这里拿底图）
    expect(new Uint8Array(store.read(`sha256:${hexOf(PNG)}`))).toEqual(PNG);
  });

  it("传不上去的那张跳过，其余照落；全都传不上去 = 原样回（没有 imageRefs）", async () => {
    const one = rig((p) => p.endsWith(".png"));
    const out = await one.mw(ctx, async () => ({ status: "ok", output: "x", images: [{ data: PNG, mimeType: "image/png" }, { data: JPEG, mimeType: "image/jpeg" }] }));
    expect(out.imageRefs?.map((r) => r.mediaType)).toEqual(["image/jpeg"]);

    const all = rig(() => true);
    const raw: ToolOutcome = { status: "ok", output: "x", images: [{ data: PNG, mimeType: "image/png" }] };
    const out2 = await all.mw(ctx, async () => raw);
    expect(out2).toBe(raw);
  });

  it("附件库不收的格式跳过、一个字节不传；失败的调用不碰", async () => {
    const { uploads, mw } = rig();
    const out = await mw(ctx, async () => ({ status: "ok", output: "x", images: [{ data: new Uint8Array([1, 2, 3]), mimeType: "image/png" }] }));
    expect(out.imageRefs).toBeUndefined();
    const err = await mw(ctx, async () => ({ status: "error", output: "上游没有返回图片", images: [{ data: PNG, mimeType: "image/png" }] }));
    expect(err.imageRefs).toBeUndefined();
    expect(uploads).toEqual([]);
  });
});

describe("imageSizeOf", () => {
  it("PNG / JPEG 读得出宽高；别的回 null", () => {
    expect(imageSizeOf(PNG)).toEqual({ width: 1, height: 1 });
    expect(imageSizeOf(JPEG)).toEqual({ width: 32, height: 16 });
    expect(imageSizeOf(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull();
  });
});

describe("decideRuntimeImageRoute", () => {
  const me: BillingMe = {
    plan: "pro", status: "active", plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
    models: ["deepseek-flash"], imageModels: ["gemini-2.5-flash-image", RUNTIME_IMAGE_MODEL], ttsModels: [], modelPlatforms: {}, decision: { models: [], uses: {} },
  };
  const base = { edgeBase: "https://edge.example", runtimeSecret: "sek", ownerUid: "33333333-3333-4333-8333-333333333333", workspaceId: WS, sessionId: SID };

  it("走得通：/llm/v1/images、平台身份 + 代表所有者 + 会话头，型号钉默认那款", () => {
    const r = decideRuntimeImageRoute({ ...base, me, agentId: "admin" });
    expect(r).toEqual({
      url: "https://edge.example/llm/v1/images",
      model: RUNTIME_IMAGE_MODEL,
      headers: { "x-runtime-secret": "sek", [ON_BEHALF_HEADER]: base.ownerUid, [WORKSPACE_HEADER]: WS, [SESSION_HEADER]: SID, [AGENT_HEADER]: "admin" },
    });
  });

  it("默认那款不在网关清单里：回落清单第一款，不报错", () => {
    const r = decideRuntimeImageRoute({ ...base, me: { ...me, imageModels: ["gpt-image-2"] } });
    expect(r).toMatchObject({ model: "gpt-image-2" });
  });

  it("走不通的四种各说各的：问不到 / 没订阅 / 额度用完 / 网关不供", () => {
    expect(decideRuntimeImageRoute({ ...base, me: "unreachable" })).toEqual({ blocked: expect.stringContaining("查不到") });
    expect(decideRuntimeImageRoute({ ...base, me: { ...me, status: "none", plan: null } })).toEqual({ blocked: expect.stringContaining("订阅") });
    expect(decideRuntimeImageRoute({ ...base, me, exhausted: true })).toEqual({ blocked: expect.stringContaining("额度用完") });
    expect(decideRuntimeImageRoute({ ...base, me: { ...me, imageModels: [] } })).toEqual({ blocked: "订阅网关暂时不供出图。" });
  });
});
