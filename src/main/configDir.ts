// 用户手编配置的目录名:`~/.mr-otto/{mcp.json,skills/,agents/}` 和工作区里的
// `<工程>/.mr-otto/agents/`。产品早改叫 Mr Otto,这个目录一直留着曾用名 `.otter`
// ——ADR-0057 统一改过来。老机器上的 `.otter` 首次遇到就整目录改名搬过去,
// 不留两份:两份并存等于两处真相,以后哪份生效谁也说不清。
//
// 这里只放目录名和搬家逻辑,不碰 Electron:纯 node fs,vitest 能注入假 fs 跑。

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

/** 配置目录名(用户级和工作区级同名) */
export const CONFIG_DIR = ".mr-otto";
/** 曾用名,只在搬家时认 */
export const LEGACY_CONFIG_DIR = ".otter";

export interface ConfigDirFs {
  exists(path: string): boolean;
  rename(from: string, to: string): void;
}

const nodeFs: ConfigDirFs = {
  exists: (p) => existsSync(p),
  rename: (a, b) => renameSync(a, b),
};

/** `<parent>/.mr-otto` 的路径;顺手把 `<parent>/.otter` 搬过来(只在新目录不存在、
    旧目录存在时)。返回新路径,不保证它存在——调用方该 mkdir 的自己 mkdir。
    搬不动(权限、跨设备)就吞掉:配置目录缺失本来就是"没配过",不该拦着启动 */
export function configDir(parent: string, fs: ConfigDirFs = nodeFs): string {
  const next = join(parent, CONFIG_DIR);
  const legacy = join(parent, LEGACY_CONFIG_DIR);
  if (!fs.exists(next) && fs.exists(legacy)) {
    try {
      fs.rename(legacy, next);
    } catch {
      // 留在原地;下次再试
    }
  }
  return next;
}
