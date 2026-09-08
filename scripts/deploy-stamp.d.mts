// scripts/deploy-stamp.mjs 的类型面（#791，ADR-0257）。
//
// 为什么要手写一份：`scripts/` 下是普通 node ESM（`node scripts/*.mjs` 直接跑，
// 不进 tsc），而这是**第一个被单测 import 的脚本**——纯函数按函数测远比起子进程
// 测有用得多（同一族的 release.mjs 是起子进程测的，因为它钉的是"哪一步先发生"）。
// 代价说清楚：这份声明是手写的，`.mjs` 那侧改了签名这里不会自动红，只有调用点会。
// 它一共两个导出、签名极稳，这个代价是接受的。

export interface StampTarget {
  entry: string;
  platform?: "node" | "neutral" | "browser";
  external?: string[];
  tsconfig?: string;
}

export function deployStamp(
  opts: StampTarget & { absWorkingDir: string }
): Promise<string>;

export function edgeBaseUrl(repoRoot: string): string;

export const STAMP_TARGETS: Readonly<Record<"edge" | "runtime", StampTarget>>;
