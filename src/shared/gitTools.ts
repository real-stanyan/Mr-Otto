// 三把 Git 刀的纯逻辑（#1105）：参数解析、目标目录的三态、push 的分支闸。
//
// 放 shared 而不是 runtime：判据要能被单测直接打，而 runtime 那几个文件里
// 塞满了 docker 与网络（同 `workFiles.ts` 只管脚本与解析的分工）。

import { normalizeWorkPath } from "./remote/workPath.js";

export const CLONE_REPO_TOOL_NAME = "clone_repo";
export const GIT_PUSH_TOOL_NAME = "git_push";
export const CREATE_REPO_TOOL_NAME = "create_repo";

/** 分支名的上限。git 自己没有硬限，这是「明显不是分支名」那道闸 */
const BRANCH_MAX = 200;
/** commit message 的上限。同上，挡的是「把一整个文件当消息发上来」 */
const MESSAGE_MAX = 4000;

/** `/work/<dest>` 里此刻是什么（#1105）。**三态，没有第四条**：
    · `empty` —— 可以 clone
    · `same-repo` —— 已经是同一个仓库了，回一句「已经在了」并跳过
    · `occupied` —— 拒绝，说清楚里面有东西

    **任何一条都不删文件。** #832 的教训是：清空是无声的，而它清掉的东西没有
    任何备份（云沙箱不许 push，那时连远端副本都没有）。「换个路径」对用户是
    一秒钟的事，而清空一次是不可逆的。 */
export type CloneTargetState = "empty" | "same-repo" | "occupied";

/** 目录探测脚本的输出 → 三态。`origin` 是 `git remote get-url origin` 的结果
    （不是 git 仓库 / 没有 origin 时为空串）。判「同一个仓库」用 `sameRepoUrl` */
export function cloneTargetState(
  probe: { entries: number; origin: string },
  repoUrl: string,
): CloneTargetState {
  if (probe.entries === 0) return "empty";
  if (probe.origin !== "" && sameRepoUrl(probe.origin, repoUrl)) return "same-repo";
  return "occupied";
}

/** 两条 https 地址指的是不是同一个仓库。结尾的 `.git`、结尾斜杠、host 大小写
    都不算差别——**路径大小写算**（GitHub 不区分而别家区分，合并两个不同仓比
    拆开同一个仓更糟，同 ADR-0211 归一化那条的取舍） */
export function sameRepoUrl(a: string, b: string): boolean {
  const norm = (raw: string): string | null => {
    try {
      const u = new URL(raw.trim());
      const path = u.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
      return `${u.host.toLowerCase()}${path}`;
    } catch {
      return null;
    }
  };
  const na = norm(a);
  const nb = norm(b);
  return na !== null && nb !== null && na === nb;
}

export interface CloneArgs {
  repoUrl: string;
  dest: string;
}

/** `clone_repo` 的参数。`dest` 过 `normalizeWorkPath`（ADR-0251：`..` 与绝对
    路径一律拒，**不解释成上跳一级**）。`dest` 为空 = 落在工作文件夹根上，
    **这里明确拒绝**：根目录几乎总是非空（别的活留下的东西），clone 进去的
    结局必然是 `occupied`，与其让人跑一趟不如当场说清楚 */
export function parseCloneArgs(raw: unknown): CloneArgs {
  const o = asObject(raw);
  const repoUrl = requireString(o, "repo_url");
  const destRaw = requireString(o, "dest");
  const dest = normalizeWorkPath(destRaw);
  if (dest === null) throw new Error(`dest 不合法：「${destRaw}」。用工作文件夹里的相对路径，例如 code/widgets`);
  if (dest === "") throw new Error("dest 不能是工作文件夹根目录——给它一个子目录，例如 code/widgets");
  return { repoUrl: repoUrl.trim(), dest };
}

export interface PushArgs {
  dest: string;
  branch: string;
  message: string;
}

/** `git_push` 的参数。分支名的三条闸都在这里：非空、不含空白与 `..`、不以
    `-` 开头（那会被 git 当成选项）。**「不许推默认分支」不在这里判**——那要
    现查远端，是 runtime 那一侧的事（而且「查不到也拒绝」是那条的重点）。 */
export function parsePushArgs(raw: unknown): PushArgs {
  const o = asObject(raw);
  const destRaw = requireString(o, "dest");
  const dest = normalizeWorkPath(destRaw);
  if (dest === null || dest === "") throw new Error(`dest 不合法：「${destRaw}」。给 clone 下来的那个子目录`);

  const branch = requireString(o, "branch").trim();
  if (branch === "") throw new Error("branch 不能为空");
  if (branch.length > BRANCH_MAX) throw new Error("branch 太长了");
  if (/\s/.test(branch) || branch.includes("..") || branch.startsWith("-") || branch.includes("~") || branch.includes("^") || branch.includes(":")) {
    throw new Error(`branch 里有 git 不接受的字符：「${branch}」`);
  }

  const message = requireString(o, "message").trim();
  if (message === "") throw new Error("message 不能为空——提交要说清楚改了什么");
  if (message.length > MESSAGE_MAX) throw new Error("message 太长了");

  return { dest, branch, message };
}

export interface CreateRepoArgs {
  name: string;
  private: boolean;
}

/** `create_repo` 的参数。名字按 GitHub 的规矩：字母数字加 `-_.`，不空不超长。
    `private` **默认 true**——建错方向的两种代价不对称：多建一个私有仓库是内务，
    把一个本该私有的仓库建成公开的是泄漏 */
export function parseCreateRepoArgs(raw: unknown): CreateRepoArgs {
  const o = asObject(raw);
  const name = requireString(o, "name").trim();
  if (name === "") throw new Error("name 不能为空");
  if (name.length > 100) throw new Error("name 太长了");
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`name 里有 GitHub 不接受的字符：「${name}」（只能用字母、数字、-、_、.）`);
  }
  const isPrivate = o["private"];
  if (isPrivate !== undefined && typeof isPrivate !== "boolean") throw new Error("private 得是 true 或 false");
  return { name, private: isPrivate ?? true };
}

/** 推的这条分支是不是远端的默认分支。**`defaultBranch` 为 null = 查不到，
    一律当成「是」**——同 ADR-0243 的纪律：没有任何输入能让这一轮比它开始时
    更松。查不到默认分支的那一刻恰恰是网络出问题的时候，而这道闸拦的是不可逆
    的写入。 */
export function pushesDefaultBranch(branch: string, defaultBranch: string | null): boolean {
  return defaultBranch === null || branch === defaultBranch;
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("参数得是一个对象");
  return raw as Record<string, unknown>;
}

function requireString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string") throw new Error(`缺少参数 ${key}`);
  return v;
}
