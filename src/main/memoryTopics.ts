// 主进程读主题桶目录（组装根允许碰 fs，硬规则挡的是工具层）。同步：readMemoryFiles
// 在 createAgent 之前就要有值（agent.ts 是同步装配）。种子 ∪ 磁盘：种子没文件时内容空。
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryTopicSnapshot } from "../session/events.js";
import { slugsFromFileNames, topicLabel, withSeedTopics } from "../shared/memoryTopics.js";

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null; // ENOENT 之外的错也当空：快照读不到宁可少一桶，别让会话开不了
  }
}

export function readTopics(topicsDir: string): MemoryTopicSnapshot[] {
  let names: string[];
  try {
    names = readdirSync(topicsDir);
  } catch {
    names = [];
  }
  return withSeedTopics(slugsFromFileNames(names)).map((slug) => ({
    slug,
    label: topicLabel(slug, readOrNull(join(topicsDir, `${slug}.label`))),
    content: readOrNull(join(topicsDir, `${slug}.md`)) ?? "",
  }));
}
