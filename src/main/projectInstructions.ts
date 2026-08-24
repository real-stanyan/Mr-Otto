// 项目指令文件加载（issue #353，codex agents_md.rs 对照——模块 doc 即规格）。
//
// bot 读工作区里的 AGENTS.md/CLAUDE.md 类文件，四条规则照抄：
// ① 查找：从 workspace 向上找 project root（标记 .git），收集 root → workspace
//    沿途每层的指令文件，**按序拼接**（不是就近覆盖）；不越过 project root
// ② 字节预算：总量上限，递减耗尽即停——防超大指令文件撑爆上下文
// ③ 信任门禁在调用方（index.ts + workspaceTrust.ts）：未信任的工作区不调本函数
// ④ provenance：每段带来源路径，注入事件原样携带，UI 展示"注入了哪几份"
// ⑤ `.override` 局部覆盖文件名优先（个人 gitignore 覆盖共享那份）
//
// 主进程模块（组装根特权可碰 fs）；fs 以接口注入，测试喂假实现（skills.ts 同款）。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface InstructionFsReader {
  /** 文件全文；不存在/读不了 = null */
  readFile(path: string): string | null;
  exists(path: string): boolean;
}

const nodeReader: InstructionFsReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  },
  exists(path) {
    return existsSync(path);
  },
};

/** 每层按此优先级取**第一个存在的**（一层最多一份）：
    override 在前（个人的、通常 gitignore 的覆盖文件赢过共享那份） */
const FILE_PRIORITY = ["AGENTS.override.md", "AGENTS.md", "CLAUDE.md"] as const;

/** 总字节预算（codex 默认同量级）。递减耗尽即停：装不下的整段丢弃并标记
    truncated——截半句指令比不注入更糟（半句规则会被模型当完整规则执行） */
export const INSTRUCTIONS_BYTE_BUDGET = 32 * 1024;

/** 向上找 project root 的最大层数（防挂载点/无 .git 的深目录走到天荒地老） */
const MAX_ASCEND = 12;

export interface InstructionSegment {
  /** 来源全路径（provenance——UI 展示"这段从哪来"） */
  path: string;
  content: string;
}

export interface ProjectInstructions {
  segments: InstructionSegment[];
  /** true = 有指令文件因预算被整段丢弃 */
  truncated: boolean;
}

/** 从 workspace 收集项目指令。找不到任何文件 = segments 空数组 */
export function findProjectInstructions(
  workspace: string,
  reader: InstructionFsReader = nodeReader
): ProjectInstructions {
  // 从 workspace 向上走到 root（第一个带 .git 的目录，含）；到 root 即停——
  // 不越过 project root。一路没有 .git = 只认 workspace 自身（陌生上级目录的
  // AGENTS.md 不该混进来）
  const climbed: string[] = [];
  let dir = workspace;
  for (let i = 0; i <= MAX_ASCEND; i++) {
    climbed.push(dir);
    if (reader.exists(join(dir, ".git"))) break;
    const parent = dirname(dir);
    if (parent === dir) break; // 到文件系统顶了
    dir = parent;
  }
  const rooted = reader.exists(join(climbed.at(-1)!, ".git"));
  const levels = rooted ? climbed : [workspace];
  levels.reverse(); // root → workspace 按序拼接

  let budget = INSTRUCTIONS_BYTE_BUDGET;
  let truncated = false;
  const segments: InstructionSegment[] = [];
  for (const level of levels) {
    const file = FILE_PRIORITY.map((n) => join(level, n)).find((p) => reader.exists(p));
    if (!file) continue;
    const content = reader.readFile(file);
    if (content === null || content.trim() === "") continue;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > budget) {
      truncated = true;
      continue; // 整段丢弃（不截半句），继续看更近层的小文件还装不装得下
    }
    budget -= bytes;
    segments.push({ path: file, content });
  }
  return { segments, truncated };
}
