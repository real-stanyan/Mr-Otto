// skill 库 — 扫描本机已安装的 skill（Claude Code 兼容格式：<根目录>/<名字>/SKILL.md）。
// skill = 纯提示词包（markdown 指令），不是代码插件：注入即"把说明书塞进上下文"，
// 不引入任何可执行扩展面（MVP 边界里"不做插件系统"原样成立，见 docs/adr/0007）。
// 主进程模块（组装根特权可碰 fs）；解析是纯函数，fs 以接口注入，测试喂假实现。

import { cpSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExternalSkillInfo, SkillImportResult, SkillInfo } from "../shared/shellBridge.js";

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

/** 解析 SKILL.md 的 YAML frontmatter。只认单行 `name:` / `description:` /
    `argument-hint:`——不引 YAML 库：skill 元数据就三个字段，一个正则的事，
    别为它背一棵依赖树。argument-hint（Claude Code 同名约定，如 "[lite|full|ultra]"）
    是给用户看的参数提示，常带引号，剥掉 */
export function parseSkillMd(text: string): {
  name?: string;
  description?: string;
  argumentHint?: string;
} {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string; argumentHint?: string } = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^(name|description|argument-hint):\s*(.+?)\s*$/);
    if (!kv) continue;
    const value = kv[2]!.replace(/^(["'])(.*)\1$/, "$2");
    if (kv[1] === "argument-hint") out.argumentHint = value;
    else out[kv[1] as "name" | "description"] = value;
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
        byName.set(name, {
          name,
          description: fm.description ?? "",
          path,
          source: root,
          content,
          ...(fm.argumentHint !== undefined ? { argumentHint: fm.argumentHint } : {}),
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ── 导入其他厂家 agent 的 skill ──────────────────────────────────────
// skill 库默认只读 Mr Otto 自己的根目录（不再静默混入别家的安装位）：
// 别家目录里的 skill 是"可导入的候选"，不是"已安装"。导入 = 整个 skill
// 目录复制进 ~/.mr-otto/skills——复制而非引用，别家卸载/改动不影响这边。

export interface ExternalSkillSource {
  /** 展示给用户的厂家名 */
  vendor: string;
  root: string;
}

/** 已知的其他厂家 skill 安装位（都是 Claude Code 兼容格式：<根>/<名字>/SKILL.md）。
    新厂家往这里加一行即可 */
export function externalSkillSources(home: string): ExternalSkillSource[] {
  return [
    { vendor: "Claude Code", root: join(home, ".claude", "skills") },
    { vendor: "Codex", root: join(home, ".codex", "skills") },
  ];
}

/** 内部富类型：比过桥的 ExternalSkillInfo 多 srcDir（导入复制的来源路径）。
    渲染层拿不到路径——导入按 name 走，主进程现扫现配，渲染层被攻破也
    指定不了任意目录去复制 */
interface ExternalSkillEntry extends ExternalSkillInfo {
  srcDir: string;
  /** 目标目录名（沿用来源目录名，不用 frontmatter name——路径是文件系统的事） */
  dirName: string;
}

function scanExternalEntries(
  sources: ExternalSkillSource[],
  installedNames: ReadonlySet<string>,
  reader: SkillDirReader
): ExternalSkillEntry[] {
  const byName = new Map<string, ExternalSkillEntry>();
  for (const { vendor, root } of sources) {
    for (const dirName of reader.listDirs(root)) {
      const content = reader.readFile(join(root, dirName, "SKILL.md"));
      if (content === null) continue;
      const fm = parseSkillMd(content);
      const name = fm.name ?? dirName;
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          description: fm.description ?? "",
          vendor,
          installed: installedNames.has(name),
          srcDir: join(root, dirName),
          dirName,
        });
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 弹窗清单：别家装了哪些 skill，各来自谁，哪些与已装同名（同名不可导入） */
export function scanExternalSkills(
  sources: ExternalSkillSource[],
  installedNames: ReadonlySet<string>,
  reader: SkillDirReader = nodeReader
): ExternalSkillInfo[] {
  return scanExternalEntries(sources, installedNames, reader).map(
    ({ name, description, vendor, installed }) => ({ name, description, vendor, installed })
  );
}

export interface SkillCopier {
  exists(path: string): boolean;
  /** 递归复制整个目录（skill 可能带 references/ 等附属文件） */
  copyDir(src: string, dest: string): void;
}

const nodeCopier: SkillCopier = {
  exists: (path) => existsSync(path),
  copyDir: (src, dest) => cpSync(src, dest, { recursive: true }),
};

/** 按 name 把别家 skill 复制进 destRoot。逐条返回结果，不整批 reject——
    一条撞名不该拖垮其余的导入 */
export function importExternalSkills(
  names: string[],
  sources: ExternalSkillSource[],
  destRoot: string,
  reader: SkillDirReader = nodeReader,
  copier: SkillCopier = nodeCopier
): SkillImportResult[] {
  const installed = new Set(scanSkills([destRoot], reader).map((s) => s.name));
  const externals = scanExternalEntries(sources, installed, reader);
  return names.map((name) => {
    const found = externals.find((e) => e.name === name);
    if (!found) return { name, ok: false, reason: "来源里找不到该 skill" };
    if (installed.has(name)) return { name, ok: false, reason: "同名 skill 已存在" };
    const dest = join(destRoot, found.dirName);
    if (copier.exists(dest)) return { name, ok: false, reason: "目标目录已存在" };
    try {
      copier.copyDir(found.srcDir, dest);
    } catch (e) {
      return { name, ok: false, reason: e instanceof Error ? e.message : String(e) };
    }
    installed.add(name); // 同一批里重复勾了同名项，后一条按"已存在"挡下
    return { name, ok: true };
  });
}
