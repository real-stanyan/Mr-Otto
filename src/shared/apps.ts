// apps —— Otto 应用（#1591，spec docs/superpowers/specs/2026-10-05-otto-apps-design.md）的纯逻辑：清单怎么解、
// 一包文件合不合规、文件在 Storage 里放哪。runtime 的 build_app 按它校验、手机按它下载，两端同一份判据。
import { scanThreat } from "./threatPatterns.js";

export const BUILD_APP_TOOL_NAME = "build_app";
export const APP_BUCKET = "otto-apps";
/** 专员把应用写在沙箱的这个目录下（`/work/apps/<slug>/`） */
export const APP_WORK_ROOT = "apps";

export const APP_NAME_MAX = 24;
export const APP_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;
export const APP_FILES_MAX = 40;
export const APP_FILE_BYTES_MAX = 512 * 1024;
export const APP_TOTAL_BYTES_MAX = 3 * 1024 * 1024;
export const APP_ENTRY = "index.html";
export const APP_MANIFEST_FILE = "manifest.json";

/** 桥能力（spec §3.2）。第一版四件 + 按需的原生能力；清单里没声明的调了就拒 */
export const APP_CAPABILITIES = ["storage", "ask", "share", "nav", "notify", "remind", "camera", "haptic", "room"] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];

/** 文件扩展名白名单：能进 WebView 的静态资源。没有 .wasm / .mjs 之外的脚本形态 */
export const APP_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "js", "mjs", "css", "json", "svg", "png", "jpg", "jpeg", "webp", "gif", "txt", "md", "woff2"]);
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set(["html", "htm", "js", "mjs", "css", "json", "svg", "txt", "md"]);

export interface AppManifest {
  name: string;
  slug: string;
  /** 一个 emoji 或一两个字 */
  icon: string;
  entry: string;
  capabilities: AppCapability[];
  /** 专员自己定的设计系统（spec §8 第 3 条）：原样留着，后续版本沿用 */
  design?: Record<string, unknown>;
  /** 数据 schema 的说明（给智能体读 app_data 时看），原样留着 */
  dataSchema?: Record<string, unknown>;
  /** 一句话说这是什么 */
  description: string;
}

export interface AppFile {
  /** 相对入口目录的路径，`/` 分隔，不以 `/` 开头 */
  path: string;
  bytes: Uint8Array;
}

export interface AppFileEntry {
  path: string;
  size: number;
  sha256: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** manifest.json → AppManifest。形状不对就抛（build_app 把这句话原样给模型改） */
export function parseAppManifest(raw: unknown): AppManifest {
  if (!isObj(raw)) throw new Error("manifest.json 不是一个对象");
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (name === "" || [...name].length > APP_NAME_MAX) throw new Error(`manifest.name 要 1–${APP_NAME_MAX} 个字`);
  const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!APP_SLUG_RE.test(slug)) throw new Error("manifest.slug 要是 2–32 位的小写字母 / 数字 / 连字符（它是目录名，也是应用的稳定键）");
  const icon = typeof raw.icon === "string" ? raw.icon.trim() : "";
  if (icon === "" || [...icon].length > 2) throw new Error("manifest.icon 要是一个 emoji 或一两个字");
  const entry = typeof raw.entry === "string" && raw.entry.trim() !== "" ? raw.entry.trim() : APP_ENTRY;
  if (!safeRelPath(entry) || !entry.endsWith(".html")) throw new Error("manifest.entry 要是包里的一个 .html");
  const caps = Array.isArray(raw.capabilities) ? raw.capabilities : [];
  const capabilities: AppCapability[] = [];
  for (const c of caps) {
    if (!(APP_CAPABILITIES as readonly unknown[]).includes(c)) throw new Error(`manifest.capabilities 里有不认识的「${String(c)}」；可选：${APP_CAPABILITIES.join(" / ")}`);
    if (!capabilities.includes(c as AppCapability)) capabilities.push(c as AppCapability);
  }
  const description = typeof raw.description === "string" ? raw.description.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return {
    name, slug, icon, entry, capabilities, description,
    ...(isObj(raw.design) ? { design: raw.design } : {}),
    ...(isObj(raw.dataSchema) ? { dataSchema: raw.dataSchema } : {}),
  };
}

/** 路径安全：相对、`/` 分隔、不含 `..` / 空段 / 控制字符 / 反斜杠 */
export function safeRelPath(p: string): boolean {
  if (p === "" || p.length > 200 || p.startsWith("/") || p.includes("\\") || /[\u0000-\u001f]/.test(p)) return false;
  const segs = p.split("/");
  return segs.every((s) => s !== "" && s !== "." && s !== "..");
}

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

/** 静态检查里拦的那几样（spec §3.1「没有外网」）：外链脚本 / 样式、网络 API、iframe、动态 import 远程 */
const NET_RULES: { name: string; re: RegExp }[] = [
  { name: "外链脚本或样式", re: /<(script|link)[^>]+(src|href)\s*=\s*["']?\s*(https?:)?\/\//i },
  { name: "网络请求", re: /\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator\.sendBeacon)\s*\(/ },
  { name: "iframe", re: /<iframe\b/i },
  { name: "远程 import", re: /\bimport\s*\(\s*["'](https?:)?\/\// },
];

export interface AppCheckInput {
  manifest: AppManifest;
  files: readonly { path: string; size: number; text: string | null }[];
}

/** 一包文件合不合规。回 null = 合规；否则一句给模型改的话。只看形状和静态规则，不执行 */
export function checkAppFiles(o: AppCheckInput): string | null {
  const { manifest, files } = o;
  if (files.length === 0) return "目录里没有文件";
  if (files.length > APP_FILES_MAX) return `文件太多（${files.length} 个，最多 ${APP_FILES_MAX}）`;
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!safeRelPath(f.path)) return `路径不合规：${f.path}`;
    if (seen.has(f.path)) return `重复的路径：${f.path}`;
    seen.add(f.path);
    const ext = extOf(f.path);
    if (!APP_EXTENSIONS.has(ext)) return `不允许的文件类型：${f.path}（能用：${[...APP_EXTENSIONS].join(" ")}）`;
    if (f.size > APP_FILE_BYTES_MAX) return `${f.path} 太大（${Math.round(f.size / 1024)} KB，单文件最多 ${APP_FILE_BYTES_MAX / 1024} KB）`;
    total += f.size;
    if (f.text !== null) {
      for (const r of NET_RULES) if (r.re.test(f.text)) return `${f.path} 里有${r.name}——应用没有外网，要数据走 window.otto 的桥`;
      const hit = scanThreat(f.text);
      if (hit !== null) return `${f.path} 含可疑指令（${hit}）`;
    }
  }
  if (total > APP_TOTAL_BYTES_MAX) return `总体积太大（${Math.round(total / 1024)} KB，最多 ${APP_TOTAL_BYTES_MAX / 1024} KB）`;
  if (!seen.has(manifest.entry)) return `入口 ${manifest.entry} 不在包里`;
  if (!seen.has(APP_MANIFEST_FILE)) return `包里要有 ${APP_MANIFEST_FILE}`;
  return null;
}

export function isTextExtension(path: string): boolean {
  return TEXT_EXTENSIONS.has(extOf(path));
}

export function contentTypeOf(path: string): string {
  switch (extOf(path)) {
    case "html": case "htm": return "text/html; charset=utf-8";
    case "js": case "mjs": return "text/javascript; charset=utf-8";
    case "css": return "text/css; charset=utf-8";
    case "json": return "application/json";
    case "svg": return "image/svg+xml";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "woff2": return "font/woff2";
    default: return "text/plain; charset=utf-8";
  }
}

/** Storage 里的对象路径：`<uid>/<appId>/<version>/<path>`——桶的 RLS 按第一段认本人 */
export function appObjectPath(uid: string, appId: string, version: number, path: string): string {
  return `${uid}/${appId}/${version}/${path}`;
}

export interface AppRow {
  id: string;
  workspaceId: string;
  ownerUid: string;
  slug: string;
  name: string;
  icon: string;
  description: string;
  currentVersion: number;
  createdByAgent: string;
  updatedTs: number;
}

export interface AppVersionRow {
  appId: string;
  version: number;
  manifest: AppManifest;
  files: AppFileEntry[];
  builtByAgent: string;
  note: string;
  createdTs: number;
}

export function appRowOf(raw: unknown): AppRow | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (typeof r.id !== "string" || typeof r.workspace_id !== "string" || typeof r.owner_uid !== "string" || typeof r.slug !== "string") return null;
  if (typeof r.name !== "string" || typeof r.current_version !== "number" || typeof r.updated_at !== "string") return null;
  const updated = Date.parse(r.updated_at);
  if (Number.isNaN(updated)) return null;
  return {
    id: r.id, workspaceId: r.workspace_id, ownerUid: r.owner_uid, slug: r.slug, name: r.name,
    icon: typeof r.icon === "string" ? r.icon : "▫", description: typeof r.description === "string" ? r.description : "",
    currentVersion: r.current_version, createdByAgent: typeof r.created_by_agent === "string" ? r.created_by_agent : "",
    updatedTs: updated,
  };
}

export function appVersionRowOf(raw: unknown): AppVersionRow | null {
  if (!isObj(raw)) return null;
  const r = raw;
  if (typeof r.app_id !== "string" || typeof r.version !== "number" || typeof r.created_at !== "string") return null;
  let manifest: AppManifest;
  try {
    manifest = parseAppManifest(r.manifest);
  } catch {
    return null;
  }
  const files = Array.isArray(r.files)
    ? r.files.filter((f): f is AppFileEntry => isObj(f) && typeof f.path === "string" && typeof f.size === "number" && typeof f.sha256 === "string")
    : [];
  const created = Date.parse(r.created_at);
  if (Number.isNaN(created)) return null;
  return { appId: r.app_id, version: r.version, manifest, files, builtByAgent: typeof r.built_by_agent === "string" ? r.built_by_agent : "", note: typeof r.note === "string" ? r.note : "", createdTs: created };
}
