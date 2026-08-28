// workspaceLockFile —— 工作区跨进程锁的落盘那一半（issue #634，ADR-0154）
//
// 纯逻辑（判据、文件名、提示语）在 shared/workspaceLock.ts；这里只做读写、pid 探活、
// 心跳定时器。落点是机器级临时目录——两个 app 实例看得见同一份，用户的工作区一个
// 字节都不动（理由见 shared 那份的文件头）。
//
// 失败一律 fail-open：读不到/写不进（权限、只读盘、临时目录被清）就当没有锁。
// 这一层是**额外**的一道，进程内那道（ADR-0152）照常成立；为了一个辅助锁把人挡在
// 门外是更坏的结果。

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEARTBEAT_MS,
  crossProcessMessage,
  lockFileName,
  lockHeld,
  type WorkspaceLockFile,
} from "../shared/workspaceLock.js";

const LOCK_DIR = join(tmpdir(), "mr-otto-workspace-locks");

const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** 进程还活着吗？signal 0 只做存在性检查，不真发信号。
    EPERM = 进程在但不属于我们（别的用户跑的）——那也算活着 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WorkspaceLockDeps {
  /** 这个安装叫什么（提示语里点名用） */
  appName: string;
  now?: () => number;
  /** 测试注入：默认真读 tmpdir */
  dir?: string;
}

export interface WorkspaceLockHandle {
  /** 松开锁。重复调用无副作用（turn 结束路径可能走两次） */
  release(): void;
}

export interface WorkspaceLockService {
  /** 拿锁。别的进程正持着 → 返回它的提示语（字符串）；拿到了 → 返回句柄 */
  acquire(workspace: string, sessionId: string): WorkspaceLockHandle | string;
}

export function createWorkspaceLock(deps: WorkspaceLockDeps): WorkspaceLockService {
  const dir = deps.dir ?? LOCK_DIR;
  const now = deps.now ?? Date.now;

  const pathFor = (workspace: string) => join(dir, lockFileName(workspace, sha256Hex));

  const readLock = (file: string): WorkspaceLockFile | null => {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<WorkspaceLockFile>;
      if (typeof raw.pid !== "number" || typeof raw.heartbeatTs !== "number") return null;
      return {
        pid: raw.pid,
        heartbeatTs: raw.heartbeatTs,
        sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
        app: typeof raw.app === "string" ? raw.app : "Mr Otto",
      };
    } catch {
      return null; // 没有 / 坏了 / 读不动 → 当作没锁（fail-open）
    }
  };

  const write = (file: string, sessionId: string) => {
    const body: WorkspaceLockFile = {
      pid: process.pid,
      sessionId,
      app: deps.appName,
      heartbeatTs: now(),
    };
    writeFileSync(file, JSON.stringify(body), "utf8");
  };

  return {
    acquire(workspace, sessionId) {
      const file = pathFor(workspace);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        return { release: () => {} }; // 建不了目录：没有这一层，照常放行
      }

      const existing = readLock(file);
      if (existing && lockHeld(existing, now(), pidAlive, process.pid)) {
        return crossProcessMessage(existing, workspace);
      }

      try {
        write(file, sessionId);
      } catch {
        return { release: () => {} }; // 写不进：同上，不挡人
      }

      // turn 可以跑很久，心跳必须在跑的过程中持续刷新，否则别人会当它陈旧抢走
      const timer = setInterval(() => {
        try {
          write(file, sessionId);
        } catch {
          // 刷不动就算了：最坏结果是别人在 STALE_AFTER_MS 之后认为我们死了
        }
      }, HEARTBEAT_MS);
      timer.unref?.(); // 别因为一个心跳把进程吊住

      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          try {
            rmSync(file, { force: true });
          } catch {
            // 删不掉就留给心跳过期兜底
          }
        },
      };
    },
  };
}
