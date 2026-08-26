// Supabase JWT(HS256)验签 —— 这个服务的身份边界。
//
// 手写而不装 jose：迁到 Supabase Cloud 后签发密钥被切回 legacy HS256(docs/adr/0098),
// 所以对称验签这条路仍然成立。验一个 HS256 就是一次 HMAC + 一次定长比较,
// 依赖换不来更少的代码。代价是必须自己堵住 JWT 的经典坑,
// 下面三条注释标的就是那三个坑,tests/edge/jwt.test.ts 逐条钉住。
//
// **用 WebCrypto 而不是 node:crypto**(ADR-0129):Worker 运行时没有 node:crypto,
// 要有得开 nodejs_compat —— 为一次 HMAC 拉进整个 Node 兼容层不划算。
// WebCrypto 两个运行时都原生有,这个文件于是运行时无关。
// 附带的好处:subtle.verify 自己就是定长比较,不用再手写 timingSafeEqual,
// 也不用先比长度(那是 timingSafeEqual 对不等长入参会抛留下的补丁)。
// 代价:验签变成异步的,调用方要 await。

export interface JwtClaims {
  /** Supabase user id(uuid) */
  sub: string;
  email: string;
  /** 过期时刻(秒) */
  exp: number;
}

export type JwtResult =
  | { ok: true; claims: JwtClaims }
  | { ok: false; reason: string };

/** base64url → 字节。不用 Buffer:那也是 node 的东西。
    返回类型写死 Uint8Array<ArrayBuffer>(而不是默认的 ArrayBufferLike):
    WebCrypto 的 BufferSource 不收可能是 SharedArrayBuffer 的那一种 */
function b64urlToBytes(seg: string): Uint8Array<ArrayBuffer> | null {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeSegment(seg: string): unknown {
  const bytes = b64urlToBytes(seg);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * @param nowSeconds 注入而不是读时钟：过期判断要能被测试逐秒钉死
 */
export async function verifyJwt(
  token: string,
  secret: string,
  nowSeconds: number
): Promise<JwtResult> {
  if (!secret) return { ok: false, reason: "服务端未配置 JWT secret" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "token 格式不对" };
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string];

  const header = decodeSegment(rawHeader);
  if (!isRecord(header)) return { ok: false, reason: "header 解不开" };
  // 坑一:alg 必须白名单硬匹配。认 header 里的 alg = 让攻击者自己挑算法,
  // "none" 和 HS/RS 混淆都是从这里进来的
  if (header.alg !== "HS256") return { ok: false, reason: `不支持的 alg: ${String(header.alg)}` };

  const sig = b64urlToBytes(rawSig);
  if (!sig) return { ok: false, reason: "签名不匹配" };
  // 坑二:比较必须定长。subtle.verify 内部就是定长比较,且对长度不对的签名
  // 直接回 false —— 不会像 timingSafeEqual 那样抛
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const good = await crypto.subtle.verify(
    "HMAC",
    key,
    sig,
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!good) return { ok: false, reason: "签名不匹配" };

  const payload = decodeSegment(rawPayload);
  if (!isRecord(payload)) return { ok: false, reason: "payload 解不开" };

  // 坑三:exp 必须**存在**才算数。缺 exp 就放行 = 一把永不过期的令牌
  const exp = payload.exp;
  if (typeof exp !== "number") return { ok: false, reason: "缺少 exp" };
  if (nowSeconds >= exp) return { ok: false, reason: "token 已过期" };
  const nbf = payload.nbf;
  if (typeof nbf === "number" && nowSeconds < nbf) return { ok: false, reason: "token 尚未生效" };

  const sub = payload.sub;
  if (typeof sub !== "string" || sub === "") return { ok: false, reason: "缺少 sub" };

  return {
    ok: true,
    claims: { sub, email: typeof payload.email === "string" ? payload.email : "", exp },
  };
}
