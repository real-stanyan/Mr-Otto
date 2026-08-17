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
