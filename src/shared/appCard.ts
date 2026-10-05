// appCard —— 把一个 Otto 应用分享给好友（#1648）：私聊里一条信封（同名片的形状，ADR-0354），对方点「添加」=
// runtime 复制一份到对方名下（文件复制到对方的桶路径、对方主场多一行 apps，数据各存各的）。
// 与名片不同：卡里只放引用（appId / version）不放文件——文件装不进 4000 字的私信，而且对方读不到发的人的桶。
// 引用不怕被冒用：添加时 runtime 现读那条私信（发的人 / 收的人 / 正文），认的是「这条私信是发给你的、发的人确实有这个应用」。
import { APP_SLUG_RE } from "./apps.js";
import { DM_BODY_MAX } from "./contactCard.js";

export const APP_CARD_KIND = "otto.app-card";

export interface AppShareCard {
  appId: string;
  version: number;
  name: string;
  icon: string;
  slug: string;
  description: string;
  from: { uid: string; name: string };
}

interface AppCardEnvelope {
  otto: typeof APP_CARD_KIND;
  v: 1;
  card: AppShareCard;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

export function encodeAppCard(card: AppShareCard): string {
  const body = JSON.stringify({ otto: APP_CARD_KIND, v: 1, card } satisfies AppCardEnvelope);
  if (body.length > DM_BODY_MAX) throw new Error("这个应用的说明太长，分享不了");
  return body;
}

/** 解：认得出回卡，认不出（普通私信 / 名片 / 别的信封）回 null。严格：一格不对整张不认 */
export function decodeAppCard(body: string): AppShareCard | null {
  if (body.length > DM_BODY_MAX || !body.startsWith("{")) return null;
  let o: unknown;
  try {
    o = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const env = o as Record<string, unknown>;
  if (env.otto !== APP_CARD_KIND || env.v !== 1 || typeof env.card !== "object" || env.card === null) return null;
  const c = env.card as Record<string, unknown>;
  const appId = str(c.appId, 64);
  const name = str(c.name, 24);
  const icon = str(c.icon, 8);
  const slug = str(c.slug, 32);
  const description = str(c.description, 200);
  const from = typeof c.from === "object" && c.from !== null ? (c.from as Record<string, unknown>) : null;
  const fromUid = from === null ? null : str(from.uid, 64);
  const fromName = from === null ? null : str(from.name, 64);
  if (appId === null || !UUID_RE.test(appId) || name === null || name.trim() === "" || icon === null || slug === null || !APP_SLUG_RE.test(slug)) return null;
  if (description === null || fromUid === null || !UUID_RE.test(fromUid) || fromName === null) return null;
  if (typeof c.version !== "number" || !Number.isInteger(c.version) || c.version < 1) return null;
  return { appId: appId.toLowerCase(), version: c.version, name, icon, slug, description, from: { uid: fromUid.toLowerCase(), name: fromName } };
}

/** 列表第二行 / 推送 / 车道信封里怎么写这一条 */
export function appCardPreview(card: AppShareCard): string {
  return `[应用] ${card.icon} ${card.name}`;
}

/** 收的人那边这个应用是不是已经添加过：复制出来的那一行 createdByAgent 记成 `share:<源 appId>` */
export const appShareMarker = (sourceAppId: string): string => `share:${sourceAppId}`;

/** 复制到对方名下时挑一个不撞的 slug：原样、-2、-3…（slug 上限 32） */
export function freeSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) {
    const tail = `-${i}`;
    const s = `${base.slice(0, 32 - tail.length)}${tail}`;
    if (!taken(s)) return s;
  }
  throw new Error("同名的应用太多了");
}
