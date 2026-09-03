// memories/ 前缀的唯一读写口（#852，ADR-0206）。云同步要在「每次本地写完」这个点挂钩，
// 而写路径原本散在四处（memoryEditDeps / 三个设置页 handler 的裸 rm/writeFile /
// LocalWorld 的 config 能力）——散着挂就会漏，漏一处云端就少一份。这里收成一个对象，
// 架构测试（tests/architecture.test.ts）钉住：碰 memories/ 路径的文件不许再 import node:fs。
// 工具那条写路径（LocalWorld.config.write）不经这里，它用 onConfigWrite 钩子汇进同一个 sync。
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  memoryRelPath, PROJECT_MEMORY_FILE, PROJECT_MERGED_FILE, PROJECT_ROOT_FILE, type MemoryTarget,
} from "../shared/memoryStore.js";
import { TOPICS_DIR, topicLabelRelPath, topicRelPath } from "../shared/memoryTopics.js";
import type { MemoryTopicSnapshot } from "../session/events.js";
import { readTopics } from "./memoryTopics.js";
import { projectMemoryDir, resolveProjectScope } from "./projectRoot.js";

export const MEMORY_PREFIX = "memories/";

export interface MemoryFiles {
  root: string;
  /** 读；ENOENT → ""（别的错误抛） */
  read(rel: string): Promise<string>;
  /** 同步读；ENOENT → ""；别的错误 console.error 后回 ""（会话装配那条路不能因为记忆文件坏了起不来） */
  readSync(rel: string): string;
  write(rel: string, content: string): Promise<void>;
  /** 删文件；不存在不报错 */
  remove(rel: string): Promise<void>;
  /** 删整个目录（项目档） */
  removeDir(relDir: string): Promise<void>;
  /** memories/ 下所有文件（递归）：{ rel, content, mtimeMs }；目录不存在 → [] */
  walk(): Promise<{ rel: string; content: string; mtimeMs: number }[]>;
  readTopics(): MemoryTopicSnapshot[];
  /** `memories/projects/` 下的目录名（含已被并走的），迁移用。目录不存在 → [] */
  projectDirs(): Promise<string[]>;
  /** 设置页那份清单。`id` 是作用域键（#886：有 remote 的仓是 `host/path`，
      其余是项目根绝对路径），已被并走的目录（有 merged.txt）不列 */
  listProjects(): Promise<{ id: string; text: string }[]>;
  /** 连同**被并走的旧目录**一起删（它们装着同一份记忆的旧副本，留着等于
      「删了还看得见」；确认弹窗说的是「不可恢复」，就得真的不可恢复） */
  deleteProject(scopeId: string): Promise<void>;
  deleteTopic(slug: string): Promise<void>;
  setTopicLabel(slug: string, label: string): Promise<void>;
  readTiers(workspace: string): {
    memory: string;
    user: string;
    project?: string;
    /** 本机项目根绝对路径（提示词文案 / 点名检测用） */
    projectRoot?: string;
    /** 作用域键（目录哈希的原文 = root.txt 的内容） */
    projectScope?: string;
    topics: MemoryTopicSnapshot[];
  };
  /** 单档单文件的内容，target/projectDir/topic → memoryRelPath → read。
      index.ts 之后不许再直接碰 memoryRelPath（Task 3 的架构断言），这是它唯一的出口 */
  readTier(target: MemoryTarget, projectDir?: string | null, topic?: string | null): Promise<string>;
}

export function createMemoryFiles(root: string, hooks: { onWrite?: (rel: string) => void } = {}): MemoryFiles {
  const notify = (rel: string) => hooks.onWrite?.(rel);
  const fence = (rel: string): string => {
    const abs = resolve(root, rel);
    const inside = abs === resolve(root, MEMORY_PREFIX.slice(0, -1)) || abs.startsWith(resolve(root, MEMORY_PREFIX));
    if (!rel.startsWith(MEMORY_PREFIX) || !inside) throw new Error(`记忆路径越界：${rel}`);
    return abs;
  };
  const toRel = (abs: string) => relative(root, abs).split(sep).join("/");
  const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT";

  async function walkDir(absDir: string, out: { rel: string; content: string; mtimeMs: number }[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
    for (const e of entries) {
      const abs = join(absDir, e.name);
      if (e.isDirectory()) await walkDir(abs, out);
      else if (e.isFile()) {
        const [content, st] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
        out.push({ rel: toRel(abs), content, mtimeMs: st.mtimeMs });
      }
    }
  }

  const files: MemoryFiles = {
    root,
    async read(rel) {
      try {
        return await readFile(fence(rel), "utf8");
      } catch (err) {
        if (isEnoent(err)) return "";
        throw err;
      }
    },
    readSync(rel) {
      try {
        return readFileSync(fence(rel), "utf8");
      } catch (err) {
        if (!isEnoent(err)) console.error(`读记忆文件 ${rel} 失败（按空处理）`, err);
        return "";
      }
    },
    async write(rel, content) {
      const abs = fence(rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, "utf8");
      notify(rel);
    },
    async remove(rel) {
      const abs = fence(rel);
      try {
        await stat(abs);
      } catch (err) {
        if (isEnoent(err)) return; // 本来就没有 = 没发生过写，不回调
        throw err;
      }
      await rm(abs, { force: true });
      notify(rel);
    },
    async removeDir(relDir) {
      const abs = fence(relDir);
      const gone: { rel: string; content: string; mtimeMs: number }[] = [];
      await walkDir(abs, gone);
      await rm(abs, { recursive: true, force: true });
      for (const g of gone) notify(g.rel);
    },
    async walk() {
      const out: { rel: string; content: string; mtimeMs: number }[] = [];
      await walkDir(resolve(root, MEMORY_PREFIX), out);
      return out;
    },
    readTopics: () => readTopics(join(root, TOPICS_DIR)),
    async projectDirs() {
      try {
        return await readdir(join(root, "memories", "projects"));
      } catch {
        return []; // 目录还不存在 = 一份项目记忆都没写过，不是故障
      }
    },
    async listProjects() {
      const out: { id: string; text: string }[] = [];
      for (const n of await files.projectDirs()) {
        if (await files.read(`memories/projects/${n}/${PROJECT_MERGED_FILE}`)) continue; // 已并走的旧副本
        const id = await files.read(`memories/projects/${n}/${PROJECT_ROOT_FILE}`);
        if (!id) continue; // 没有 root.txt = 不自描述的孤儿目录，不列
        out.push({ id: id.trim(), text: await files.read(`memories/projects/${n}/${PROJECT_MEMORY_FILE}`) });
      }
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    async deleteProject(scopeId) {
      await files.removeDir(projectMemoryDir(scopeId));
      for (const n of await files.projectDirs()) {
        const merged = (await files.read(`memories/projects/${n}/${PROJECT_MERGED_FILE}`)).trim();
        if (merged === scopeId) await files.removeDir(`memories/projects/${n}`);
      }
    },
    async deleteTopic(slug) {
      // 两条路径都无条件回调（不像 remove() 那样先探是否存在）：删桶是一个概念上的
      // 单一动作，云端要能收到「这个桶没了」的信号去清两个文件，哪怕本地 label
      // 从没建过（或已经删过一次）——多发一次删除请求是幂等的，漏发一次却会让
      // 云端留着本地已经不存在的残档
      const mdAbs = fence(topicRelPath(slug));
      const labelAbs = fence(topicLabelRelPath(slug));
      await rm(mdAbs, { force: true });
      notify(topicRelPath(slug));
      await rm(labelAbs, { force: true });
      notify(topicLabelRelPath(slug));
    },
    async setTopicLabel(slug, label) {
      const rel = topicLabelRelPath(slug);
      if (!label.trim()) await files.remove(rel);
      else await files.write(rel, label.trim());
    },
    readTiers(workspace) {
      const base = {
        memory: files.readSync(memoryRelPath("memory")),
        user: files.readSync(memoryRelPath("user")),
        topics: files.readTopics(),
      };
      const scope = resolveProjectScope(workspace);
      if (!scope) return base;
      return {
        ...base,
        project: files.readSync(memoryRelPath("project", projectMemoryDir(scope.id))),
        projectRoot: scope.root,
        projectScope: scope.id,
      };
    },
    readTier: (target, projectDir, topic) => files.read(memoryRelPath(target, projectDir, topic)),
  };
  return files;
}
