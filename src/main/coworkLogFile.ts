// coworkLogFile —— 协作记录的读写落盘（issue #658）。纯逻辑在 shared/coworkLog.ts。
//
// 为什么用 node fs 直接写，而不是走 world.fs：
// `ExecutionWorld.fs` 只有 read/write，没有 append——用它就得「读出来、拼上、写回去」，
// 而这个本子存在的全部理由就是**两个进程同时在写**。读改写会互相覆盖，正好把要解决
// 的问题重现一遍。`appendFile` 走 O_APPEND，内核保证小块追加不交错。
//
// 这不是越过围栏：本子落在工作区根目录，本来就在围栏之内；写它的是主进程的记账
// 逻辑，不是工具（工具仍然只依赖 ExecutionWorld，硬规则不动）。先例是 imageIntake
// ——工具交东西，落盘在中间件里发生。
//
// 天花板写在这儿：v2 SandboxWorld 若真让两个容器共享一个挂载，这层就得搬进 world。
// v1 不搬——LocalWorld 是唯一的实现，提前抽象只会抽错。

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  COWORK_LOG_HEADER,
  COWORK_LOG_NAME,
  MAX_RECORDS,
  formatRecord,
  parseLog,
  trimRecords,
  type CoworkRecord,
} from "../shared/coworkLog.js";

function logPath(workspace: string): string {
  return join(workspace, COWORK_LOG_NAME);
}

/** 绝对路径 → 工作区内的相对路径。工作区之外的文件返回 null：
    本子是「这个文件夹里的水獭怎么分工」，围栏外的东西不属于这件事 */
export function relativeInWorkspace(workspace: string, target: string): string | null {
  const abs = isAbsolute(target) ? target : join(workspace, target);
  const rel = relative(workspace, abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** 读出本子里的全部留言。文件不在 / 读不动 → 空列表：
    协作记录是增强，不是前置条件，读失败绝不该挡住写盘 */
export async function readRecords(workspace: string): Promise<CoworkRecord[]> {
  try {
    return parseLog(await readFile(logPath(workspace), "utf8"));
  } catch {
    return [];
  }
}

/** 追一条留言。失败只吞不抛——同上：记不上账是遗憾，写不了文件才是事故。
    返回是否真写成了（测试与诊断用） */
export async function appendRecord(
  workspace: string,
  rec: CoworkRecord,
  tzOffsetMinutes: number
): Promise<boolean> {
  const file = logPath(workspace);
  try {
    let head = "";
    try {
      await readFile(file, "utf8");
    } catch {
      head = COWORK_LOG_HEADER; // 第一次写：带上给人看的抬头
    }
    await appendFile(file, `${head}${formatRecord(rec, tzOffsetMinutes)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 本子太长了就裁掉最旧的。
    **整份重写**，所以会和别的进程此刻的 appendFile 撞——极小概率丢掉并发写入的
    那一两行。接受：本子是近况不是事实来源（事实在各自会话的 append-only 日志里）。
    为此把触发点放在 2 倍上限而不是刚好超限——重写越少，撞上的机会越少 */
export async function trimIfNeeded(workspace: string, max = MAX_RECORDS): Promise<void> {
  try {
    const text = await readFile(logPath(workspace), "utf8");
    const records = parseLog(text);
    if (records.length <= max * 2) return;
    const kept = trimRecords(records, max);
    const tz = -new Date().getTimezoneOffset();
    await writeFile(
      logPath(workspace),
      COWORK_LOG_HEADER + kept.map((r) => formatRecord(r, tz)).join("\n") + "\n",
      "utf8"
    );
  } catch {
    // 裁不动就留着长——本子长一点没有任何危害
  }
}
