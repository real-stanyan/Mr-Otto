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
     * 按**形状**判而不是按 key 名硬拼（supabase 的 key 是
     * `sb-${hostname.split(".")[0]}-auth-token`）：硬拼的失败模式很糟——supabase 哪天
     * 改了 key 方案，用户会掉进「登录了也进不去」的死循环（新 token 写在新 key 下，
     * 我们按老 key 查永远查不到）。按形状判则退化成「多认一份退役项目的旧 token」，
     * 量级小得多，而且那种人进去之后处处是未登录态，本来就是闸门故意放行的那一类。
     */
    hasSession(): boolean {
      for (const [key, value] of Object.entries(loadFile(filePath, io))) {
        // PKCE 的 code verifier 只证明有人点过按钮，不证明登录成功过
        if (key.includes("code-verifier")) continue;
        if (typeof value !== "string") continue;
        try {
          const parsed: unknown = JSON.parse(value);
          if (
            parsed !== null &&
            typeof parsed === "object" &&
            typeof (parsed as { access_token?: unknown }).access_token === "string" &&
            (parsed as { access_token: string }).access_token !== ""
          ) {
            return true;
          }
        } catch {
          // 解析不了就不是 session（code verifier 是裸串，走不到这儿也无妨）
        }
      }
      return false;
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
