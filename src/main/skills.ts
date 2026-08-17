// skill 库 — 扫描本机已安装的 skill（Claude Code 兼容格式：<根目录>/<名字>/SKILL.md）。
// skill = 纯提示词包（markdown 指令），不是代码插件：注入即"把说明书塞进上下文"，
// 不引入任何可执行扩展面（MVP 边界里"不做插件系统"原样成立，见 docs/adr/0007）。
// 主进程模块（组装根特权可碰 fs）；解析是纯函数，fs 以接口注入，测试喂假实现。

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillInfo } from "../shared/shellBridge.js";

export interface SkillDirReader {
  /** root 下的子目录名；root 不存在/读不了 = [] */
  listDirs(root: string): string[];
  /** 文件全文；不存在/读不了 = null */
  readFile(path: string): string | null;
}

const nodeReader: SkillDirReader = {
  listDirs(root) {
    try {
      return readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  },
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
};

/** 解析 SKILL.md 的 YAML frontmatter。只认单行 `name:` / `description:`——
    不引 YAML 库：skill 元数据就两个字段，一个正则的事，别为它背一棵依赖树 */
export function parseSkillMd(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(name|description):\s*(.+?)\s*$/);
    if (kv) out[kv[1] as "name" | "description"] = kv[2]!;
  }
  return out;
}

/** 按 roots 顺序扫描全部 skill。同名先到先得——otter 原生目录排在前面 = 覆盖优先。
    name 取 frontmatter，缺了退回目录名；没有 SKILL.md 的目录不是 skill，跳过。
    每次调用都现扫磁盘：skill 是用户随时增删的外部文件，缓存只会陈旧。 */
export function scanSkills(roots: string[], reader: SkillDirReader = nodeReader): SkillInfo[] {
  const byName = new Map<string, SkillInfo>();
  for (const root of roots) {
    for (const dir of reader.listDirs(root)) {
      const path = join(root, dir, "SKILL.md");
      const content = reader.readFile(path);
      if (content === null) continue;
      const fm = parseSkillMd(content);
      const name = fm.name ?? dir;
      if (!byName.has(name)) {
        byName.set(name, { name, description: fm.description ?? "", path, source: root, content });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
