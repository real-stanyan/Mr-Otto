// LocalWorld — ExecutionWorld 的本机实现。
// 整个项目里唯一允许 import node:fs / child_process 的地方（工具层禁入）。
// root 选项 = 软沙箱：文件操作圈在工程文件夹内，越界抛错。
// exec 只把 cwd 设为 root（挡不住 `cd ..`，诚实说明）——硬隔离是 v2 Docker world 的活。

import { readFile, writeFile } from "node:fs/promises";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { resolve, relative, isAbsolute } from "node:path";
import type { ExecutionWorld, ExecResult } from "./executionWorld.js";

const execAsync = promisify(cpExec);

/** 把 path 解析到 root 下并验证没越界；没配 root = 不设防（旧行为） */
function fence(root: string | undefined, path: string): string {
  if (!root) return path;
  const abs = resolve(root, path); // 相对路径落在 root 下，绝对路径原样解析
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) {
    throw new Error(`路径越出工程文件夹（${root}）: ${path}`);
  }
  return abs;
}

export function createLocalWorld(opts: { root?: string } = {}): ExecutionWorld {
  const { root } = opts;
  return {
    fs: {
      // async 包一层：fence 的同步抛错变成 Promise rejection（接口约定返回 Promise，
      // 同步 throw 会炸在调用点而不是 await 点——工具层的 try/catch 就接不住了）
      read: async (path) => readFile(fence(root, path), "utf8"),
      write: async (path, content) => writeFile(fence(root, path), content, "utf8"),
    },

    async exec(cmd): Promise<ExecResult> {
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          timeout: 30_000,
          ...(root ? { cwd: root } : {}),
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; message: string };
        return {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? e.message,
          exitCode: e.code ?? 1,
        };
      }
    },
  };
}
