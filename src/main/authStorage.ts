// authStorage — supabase-js 的自定义 auth token 存储适配器。
// 单文件 JSON 存多个 key（sb-xxx-auth-token 等），落盘 0600（同 keyVault 的权限约束）。
// 依赖通过 AuthStorageIO 注入，便于纯单测；主进程默认用 nodeIO 直碰 fs。

import { readFileSync, writeFileSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

export type AuthStorageIO = {
  read(p: string): string | null;
  write(p: string, data: string): void;
  remove(p: string): void;
};

type AuthFile = Record<string, string>;

function loadFile(filePath: string, io: AuthStorageIO): AuthFile {
  const raw = io.read(filePath);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AuthFile) : {};
  } catch {
    return {}; // 坏 JSON 当空处理
  }
}

/**
 * 文件里每一条**形状像 session** 的值。判据的唯一正文 —— `hasSession` 和
 * `sessionIdentity` 共用它：两处各写一遍形状判断，迟早会漂移出第二个真相
 * （而这个判断已经错过一次，见 #729）。
 *
 * 判据（ADR-0183）：跳过 `*-code-verifier`（PKCE 只证明有人点过按钮，不证明
 * 登录成功过），值能解析成对象、且 `access_token` 是非空字符串。
 * 按**形状**认而不是按 key 名硬拼：supabase 哪天改了 key 方案，硬拼的失败模式是
 * 「登录了也进不去」的死循环，按形状认则退化成「多认一份退役项目的旧 token」。
 */
function sessionValues(filePath: string, io: AuthStorageIO): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(loadFile(filePath, io))) {
    if (key.includes("code-verifier")) continue;
    if (typeof value !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue; // 解析不了就不是 session（code verifier 是裸串，走不到这儿也无妨）
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const token = (parsed as { access_token?: unknown }).access_token;
    if (typeof token !== "string" || token === "") continue;
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}

/**
 * 落盘 session 里的「这是谁」—— uid 和邮箱（issue #749，ADR-0187）。
 *
 * 同步、离线、不发网络：本机数据要按账号分抽屉，而抽屉在 `whenReady` 的第一行
 * 就得选定，那时 supabase client 还没造、`restore()` 的网络往返更没影子。
 * supabase 落的 session 自带 `user.id`，所以这个答案本来就在盘上，不必去问服务端。
 *
 * 没有 session（或 session 里没有 user.id）时 uid 为 null —— 调用方据此走
 * 「未登录」那一格，不是异常。
 */
export function sessionIdentity(
  filePath: string,
  io: AuthStorageIO = nodeIO,
): { uid: string | null; email: string } {
  for (const s of sessionValues(filePath, io)) {
    const user = s["user"];
    if (user === null || typeof user !== "object") continue;
    const id = (user as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") continue;
    const email = (user as { email?: unknown }).email;
    return { uid: id, email: typeof email === "string" ? email : "" };
  }
  return { uid: null, email: "" };
}

export function createAuthStorage(filePath: string, io: AuthStorageIO = nodeIO) {
  return {
    /**
     * 这台机器上「有没有登录记录」= 文件里**存着一份 session**（ADR-0183 收紧 0182）。
     *
     * 判据刻意停在**本地文件**这一层，不发网络校验：进门那道闸（SignInScreen）要的是
     * 一个**同步、离线也答得出**的答案。看 `signedIn` 不行——`AccountManager.restore()`
     * 是 fire-and-forget 且走 `auth.getUser()` 网络校验，冷启动时它多半晚于渲染层的
     * 第一问，已登录用户会被闪一下登录页；断网时它更是永远回未登录，等于把人锁在
     * 自己的桌面软件外面。
     *
     * 但「有 key」不等于「有 session」，0182 在这里判松了，被实测绕过（#729）：
     * supabase 在 `signInWithOAuth` **一开始**就往 `<storageKey>-code-verifier` 写一笔，
     * 于是「点过一次 Google 登录然后放弃」也会留下 key。维护者的 dev 目录里正是这样
     * 三条残留、一份 session 都没有，闸门却放行了。
     *
     * 形状判据（含「按形状认而不是按 key 名硬拼」的理由）在 `sessionValues` —— 它和
     * `sessionIdentity` 共用那一份，别在这儿再写一遍。
     */
    hasSession(): boolean {
      return sessionValues(filePath, io).length > 0;
    },
    getItem(key: string): string | null {
      const file = loadFile(filePath, io);
      return typeof file[key] === "string" ? file[key] : null;
    },
    setItem(key: string, value: string): void {
      const file = loadFile(filePath, io);
      file[key] = value;
      io.write(filePath, JSON.stringify(file));
    },
    removeItem(key: string): void {
      const file = loadFile(filePath, io);
      if (!(key in file)) return;
      delete file[key];
      if (Object.keys(file).length === 0) {
        io.remove(filePath);
      } else {
        io.write(filePath, JSON.stringify(file));
      }
    },
  };
}

export const nodeIO: AuthStorageIO = {
  read(p: string): string | null {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null; // 文件不存在 / 读不到 = 没存过
    }
  },
  write(p: string, data: string): void {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data, { mode: 0o600 });
    chmodSync(p, 0o600); // writeFileSync 的 mode 只在新建时生效，已有文件补一刀，保证权限恒 0600
  },
  remove(p: string): void {
    try {
      unlinkSync(p);
    } catch {
      // 文件本就不存在，忽略
    }
  },
};
