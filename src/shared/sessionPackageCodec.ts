// sessionPackageCodec —— 会话包的「线上格式」编解码（issue #611，PR#2）。
// sessionPackage.ts 出的是内存结构（SessionPackage），本文件把它变成能放上
// Supabase Storage 的一组文件，以及反向。
//
// 为什么「JSONL 事件 + 附件分开」而不是「单个大 JSON」：
//   - 附件是二进制字节。塞进 JSON 得 base64，体积立涨 33%（本期 shift 决策记录）。
//     分开存 = 附件原样走字节，一个 bit 不胀。
//   - 事件是文本，逐行一条（JSONL）——和 trajectoryExport 的 jsonl 同一个道理：
//     行是最自然的追加/流式单位，也是唯一无损的那一份。
//
// 纯逻辑、零 IO：只产出「文件名 → 字节」的映射，上传/下载由 main 层做。
// 这让它能进 vitest 纯函数测试，而不需要真 Supabase。

import type { SessionPackage, SessionPackageManifest } from "./sessionPackage.js";
import { validatePackage } from "./sessionPackage.js";

/** 包内文件名约定。接收方按这个名字找到 manifest，再按 manifest 找其余 */
export const MANIFEST_FILE = "manifest.json";
export const EVENTS_FILE = "events.jsonl";
/** 附件目录前缀：附件字节按 sha256 hex 存成独立文件 */
export const ATTACH_DIR = "attachments/";

/** 把 SessionPackage 编成一组「路径 → 字节」（相对包根的路径）。
    - manifest.json：身份与信封（小，先读它决定要不要继续下载）
    - events.jsonl：事件流，一行一条（剥隐私后的）
    - attachments/<hex>：附件字节本体（无扩展名，内容寻址——mediaType 在 manifest 台账里）
    返回 Map 保持插入顺序：manifest 在最前，方便接收方先取它。 */
export function encodePackage(pkg: SessionPackage): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const enc = new TextEncoder();

  files.set(MANIFEST_FILE, enc.encode(JSON.stringify(pkg.manifest, null, 2)));

  // 事件流：逐行一条 JSON。剥掉发送方的 seq/sessionId？不——保留。
  // 理由：seq 在包内是「原始顺序」的凭据（接收方重放校验、调试对齐用），
  // sessionId 已刻在 manifest.source。导入时 retargetForImport 才剥它们。
  const lines = pkg.events.map((e) => JSON.stringify(e));
  files.set(EVENTS_FILE, enc.encode(lines.join("\n") + "\n"));

  for (const [id, bytes] of Object.entries(pkg.attachmentBytes)) {
    // id = "sha256:<hex>"，文件名用 hex 部分（剥前缀，路径里不塞冒号）
    const hex = id.replace(/^sha256:/, "");
    files.set(`${ATTACH_DIR}${hex}`, bytes);
  }
  return files;
}

/** 反向：把一组「路径 → 字节」解回 SessionPackage。
    先做结构校验（validatePackage 那道门），返回错误数组（空 = 成功）。
    校验过不了的包不返回——接收方拿到错误列表渲染提示，而不是一个半成品包。 */
export function decodePackage(files: ReadonlyMap<string, Uint8Array>): {
  ok: true; pkg: SessionPackage;
} | {
  ok: false; errors: string[];
} {
  const dec = new TextDecoder();
  const manifestBytes = files.get(MANIFEST_FILE);
  if (!manifestBytes) return { ok: false, errors: [`缺 ${MANIFEST_FILE}`] };
  const eventsBytes = files.get(EVENTS_FILE);
  if (!eventsBytes) return { ok: false, errors: [`缺 ${EVENTS_FILE}`] };

  let manifest: SessionPackageManifest;
  try {
    manifest = JSON.parse(dec.decode(manifestBytes)) as SessionPackageManifest;
  } catch {
    return { ok: false, errors: ["manifest.json 不是合法 JSON"] };
  }

  // events.jsonl：逐行解析，空行跳过（文件末尾的换行会产一个空串）
  const events: SessionPackage["events"] = [];
  const text = dec.decode(eventsBytes);
  for (const [i, line] of text.split("\n").entries()) {
    const t = line.trim();
    if (t === "") continue;
    try {
      events.push(JSON.parse(t));
    } catch {
      return { ok: false, errors: [`events.jsonl 第 ${i + 1} 行不是合法 JSON`] };
    }
  }

  // 附件：attachments/ 下的文件，文件名（hex）拼回 sha256: 前缀
  const attachmentBytes: Record<string, Uint8Array> = {};
  for (const [path, bytes] of files) {
    if (!path.startsWith(ATTACH_DIR)) continue;
    const hex = path.slice(ATTACH_DIR.length);
    attachmentBytes[`sha256:${hex}`] = bytes;
  }

  const pkg: SessionPackage = { manifest, events, attachmentBytes };
  // 过 sessionPackage 那道结构门（kind/version/eventCount 自洽/首条 session_created）
  const errs = validatePackage(pkg);
  if (errs.length > 0) return { ok: false, errors: errs };
  return { ok: true, pkg };
}

/** 计算一个包在 Storage 里的「对象键」——所有文件共享同一个目录前缀。
    布局：{prefix}/{MANIFEST_FILE}、{prefix}/{EVENTS_FILE}、{prefix}/{ATTACH_DIR}<hex>
    prefix 由调用方定（约定 = senderUid/pkgId，见 PR#2 的发送端）。 */
export function packageKeys(prefix: string, pkg: SessionPackage): Map<string, Uint8Array> {
  const files = encodePackage(pkg);
  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of files) out.set(`${prefix}/${name}`, bytes);
  return out;
}

// ─── DM 信封 ─────────────────────────────────────────────────
// 会话包本体在 Storage，DM body 里只塞一个「信封」：一段 JSON 标记，接收方认出
// 它就渲染成可点卡片。DM body 限 4000 字符（messages 表 check），信封只带路径
// 与几句展示文本，本体一个字节不进 DM——这是「① Storage 传包、DM 当信封」的落地。

export const ENVELOPE_KIND = "otto.session-share";

/** DM body 里的信封（整个 body 就是这段 JSON，不嵌在自由文本里——
    嵌进文本就要解决「正文里出现同样 JSON 怎么办」的歧义，整段占用最干净） */
export interface ShareEnvelope {
  otto: typeof ENVELOPE_KIND;
  v: 1;
  /** Storage bucket（固定 session-packages，写出来是自描述，方便将来换 bucket） */
  bucket: string;
  /** 对象键前缀 = {senderUid}/{pkgId}，所有文件共享。接收方按它列出并下载整包 */
  prefix: string;
  /** 发送方留言（@好友时那句「这个 fork 是去干什么的」） */
  message: string;
  /** 源会话标题（接收方列表里显示用，免下载就能渲染卡片） */
  title: string | null;
  /** 包内事件条数（卡片上显示「N 条」让对方有体积预期） */
  eventCount: number;
  /**
   * 连带借出的服务清单（issue #694，ADR-0177）。缺席 = 这份分享只给对话，不借服务。
   *
   * 只是**给人看的名字**（= server id，mcp.json 里的键）。真正的白名单存在 A 那边
   * （proxyStore），握手后由 A 推 `proxy_grant` 帧过来——这里写什么都不构成授权。
   */
  grantServers?: readonly string[];
  /**
   * 代理邀请码（`otto-proxy:…`），有它才有「导入并接上对方的服务」那个按钮。
   *
   * 为什么敢把 secret 放进 DM：手动那条路本来也是 DM/当面（ADR-0151 的「带外」
   * 就是这个意思），信道没变，变的只是「谁来复制粘贴」。
   *
   * 老版本客户端读到这条信封会照常渲染卡片、认不得这两个字段——`v` 保持 1 是刻意的：
   * 涨版本会让老客户端把整条私信判成不认识（`decodeEnvelope` 的 `v !== 1` 直接 null），
   * 一个新字段不值得换来那个后果。
   */
  invite?: string;
}

/** 编信封：把分享元数据编成 DM body 字符串 */
export function encodeEnvelope(e: Omit<ShareEnvelope, "otto" | "v">): string {
  const env: ShareEnvelope = { otto: ENVELOPE_KIND, v: 1, ...e };
  return JSON.stringify(env);
}

/** 解信封：认得出就返回结构化信封，认不出（普通私信）返回 null。
    宽松解析：只认 otto 标记 + v 版本，其余字段缺失给默认——老版本收到新信封
    至少能渲染「这是一份会话分享」而不至于整条私信变乱码 */
export function decodeEnvelope(body: string): ShareEnvelope | null {
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null; // 不是 JSON = 普通私信
  }
  if (typeof o !== "object" || o === null) return null;
  const e = o as Partial<ShareEnvelope>;
  if (e.otto !== ENVELOPE_KIND) return null;
  if (e.v !== 1) return null; // 将来 v2 再说
  if (typeof e.bucket !== "string" || typeof e.prefix !== "string") return null;
  // 连带授权那两个字段是后加的（ADR-0177），一律按「可能缺席、可能是别的形状」读：
  // 信封来自网络，而老版本发的信封本来就没有它们
  const grantServers = Array.isArray(e.grantServers)
    ? e.grantServers.filter((s): s is string => typeof s === "string")
    : [];
  return {
    otto: ENVELOPE_KIND,
    v: 1,
    bucket: e.bucket,
    prefix: e.prefix,
    message: typeof e.message === "string" ? e.message : "",
    title: typeof e.title === "string" ? e.title : null,
    eventCount: typeof e.eventCount === "number" ? e.eventCount : 0,
    ...(grantServers.length > 0 ? { grantServers } : {}),
    ...(typeof e.invite === "string" && e.invite !== "" ? { invite: e.invite } : {}),
  };
}
