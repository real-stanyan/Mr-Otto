// 旧项目记忆目录并进新的作用域键（#886）。
//
// #852 之前的键是「项目根绝对路径的哈希」，换台机器路径就不同，于是同一个仓库在
// 云端有两把键、谁也读不到谁。改键之后本机那份旧目录必须搬过来，否则用户看到的是
// 「我的项目记忆没了」——这才是这个模块存在的唯一理由。
//
// 三条判断，各自的理由写在代码旁：
// ① 只有**本机能解析出 remote** 的旧目录才搬。别的机器的旧目录（root.txt 里那条
//    路径在本机不存在）留在原地——它的归属只有那台机器说得清，猜是猜不出来的。
// ② 搬 = 合并（两边条目取并集），不是覆盖。两台机器各自迁移时会先后写同一把新键，
//    覆盖就意味着后到的那台把先到的那台的记忆抹掉。
// ③ 搬完在旧目录里放一块墓碑（merged.txt）而**不删目录**。理由见 PROJECT_MERGED_FILE
//    的注释：云同步没有墓碑机制，删除会被还揣着旧副本的机器推回来；而且「跑一次就
//    不再跑」正是用户手动删掉的条目不会在下次开机被合回来的保证。
import {
  ENTRY_DELIMITER, formatEntries, parseEntries,
  PROJECT_MEMORY_FILE, PROJECT_MERGED_FILE, PROJECT_ROOT_FILE,
} from "../shared/memoryStore.js";
import type { MemoryFiles } from "./memoryFiles.js";
import { isPathScopeId, projectMemoryDir } from "./projectRoot.js";

export interface ProjectMemoryMigrateDeps {
  files: Pick<MemoryFiles, "projectDirs" | "read" | "write">;
  /** 项目根绝对路径 → 今天的作用域键（组装根传 projectScopeId：读 .git/config）。
      解析不出 remote 时返回入参本身，那就是「这个仓没有跨机身份」，不搬 */
  scopeOf: (projectRoot: string) => string;
}

/** 迁移一次，返回真正搬过的那几条（调用方打日志用）。幂等：搬过的目录带墓碑，
    第二次直接跳过——所以开机跑、对账后再跑，都不会重复合并 */
export async function migrateProjectMemories(
  deps: ProjectMemoryMigrateDeps
): Promise<{ merged: { from: string; to: string }[] }> {
  const merged: { from: string; to: string }[] = [];
  for (const name of await deps.files.projectDirs()) {
    const dir = `memories/projects/${name}`;
    if ((await deps.files.read(`${dir}/${PROJECT_MERGED_FILE}`)).trim()) continue; // 已搬过
    const id = (await deps.files.read(`${dir}/${PROJECT_ROOT_FILE}`)).trim();
    if (!id) continue; // 不自描述的孤儿目录：搬去哪儿无从判断
    if (!isPathScopeId(id)) continue; // 已经是 remote 键
    const next = deps.scopeOf(id);
    // 相等 = 没有 remote（或那条路径在本机根本不存在，读不到 .git/config）。
    // 两种情形都不该动它：前者的键本来就该是路径，后者不是本机的事
    if (next === id) continue;

    const target = projectMemoryDir(next);
    const theirs = await deps.files.read(`${target}/${PROJECT_MEMORY_FILE}`);
    const mine = await deps.files.read(`${dir}/${PROJECT_MEMORY_FILE}`);
    // parseEntries 自带 trim / 去空 / 保序去重，所以「拼起来再解析」就是并集
    const union = formatEntries(parseEntries(`${theirs}${ENTRY_DELIMITER}${mine}`));
    if (union !== theirs) await deps.files.write(`${target}/${PROJECT_MEMORY_FILE}`, union);
    // 每一次写都会通知云同步，所以内容没变就别写——否则每次开机都白推一遍
    if ((await deps.files.read(`${target}/${PROJECT_ROOT_FILE}`)).trim() !== next) {
      await deps.files.write(`${target}/${PROJECT_ROOT_FILE}`, next);
    }
    await deps.files.write(`${dir}/${PROJECT_MERGED_FILE}`, next);
    merged.push({ from: id, to: next });
  }
  return { merged };
}
