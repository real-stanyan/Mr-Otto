// 「这一组工具动了哪些文件」→ 一棵可以按行画出来的树（issue #582）。
//
// 纯函数，不碰 React：和 aui/toolArtifacts.ts 同一条纪律。
//
// 两个刻意的取舍：
//
// ① **只压一层的独生链**。`src/renderer/src/lib/a.ts` 这种路径，每层一行会把
//    四行留白摞成一堵墙，而那四行里没有一行是分叉——所以独生子女的目录连成
//    `src/renderer/src/lib` 一行。分叉处才真的缩进。
// ② **工作区外的文件不进树，各自单独一行**（depth 0，名字是完整路径）。
//    把 `/tmp/x` 和工作区里的文件塞进同一棵树，树根就得是 `/`，
//    那棵树的形状说的是磁盘的事，不是这次改动的事。

import { toWorkspaceRel } from "../../../shared/fileRefs.js";

/** 树的输入：这一组动过的一个文件。行数缺席 = 那次写盘的日志里没有 diffStat
    （改这条之前的旧日志），此时那一行就不报数字——不猜 */
export interface ChangedFile {
  /** 绝对路径 */
  path: string;
  additions?: number;
  deletions?: number;
}

export interface FileTreeNode {
  /** 树里的唯一键 = 展示路径（工作区相对；区外文件就是绝对路径） */
  path: string;
  /** 这一行显示的字：目录是压过的那一段，文件是文件名 */
  name: string;
  depth: number;
  kind: "folder" | "file";
  /** 文件才有：点它要打开的那个路径（原样，绝对） */
  full?: string;
  /** 文件才有：这一组对它加/删了多少行。两个都缺 = 日志里没有这份账 */
  additions?: number;
  deletions?: number;
}

/** 内部搭树用的可变节点。目录的 children 用 Map 保插入序 */
interface Dir {
  dirs: Map<string, Dir>;
  files: Map<string, ChangedFile>; // 展示名 → 那个文件
}

const emptyDir = (): Dir => ({ dirs: new Map(), files: new Map() });

/** 一组工具调用 → 树的输入。三件事各有出处，混在组件里就没人验得了：
    ① 只数写入（读取不是"改变"）；
    ② 路径取**实际执行**用的那份（人在审批时可能改过参数，ADR-0041）——
       这里回答的是"到底什么东西碰了磁盘"；
    ③ 行数取 `tool_result.diffStat`（ADR-0141），日志里没有就不报数字。 */
export function changedFilesOf<C extends { id: string; name: string }>(
  calls: readonly C[],
  pathOf: (call: C) => string | null,
  statOf: (id: string) => { additions: number; deletions: number } | undefined
): ChangedFile[] {
  const entries: ChangedFile[] = [];
  for (const call of calls) {
    if (call.name !== "write_file") continue;
    const path = pathOf(call);
    if (path === null) continue;
    const stat = statOf(call.id);
    entries.push({ path, ...(stat ?? {}) });
  }
  return mergeChangedFiles(entries);
}

/** 同一个文件在一组里被写了两次 → 一行,行数相加。
    「有账」和「没账」混在一起时,只把有账的加起来:一次旧日志的写盘不该
    把这个文件的行数抹成 0,也不该让它冒充"这次只改了后一半"。
    全都没账才真的没账（返回的那条不带 additions/deletions） */
export function mergeChangedFiles(entries: readonly ChangedFile[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const e of entries) {
    const prev = byPath.get(e.path);
    if (prev === undefined) {
      byPath.set(e.path, { ...e });
      continue;
    }
    const add = sum(prev.additions, e.additions);
    const del = sum(prev.deletions, e.deletions);
    byPath.set(e.path, {
      path: e.path,
      ...(add === undefined ? {} : { additions: add }),
      ...(del === undefined ? {} : { deletions: del }),
    });
  }
  return [...byPath.values()];
}

function sum(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return a + b;
}

/**
 * @param files 这一组动过的文件（绝对路径；重复的先过 mergeChangedFiles）
 * @param workspace 当前会话的工作区。空串 = 没有工作区，所有路径按区外处理
 */
export function fileTreeNodes(
  files: readonly ChangedFile[],
  workspace: string
): FileTreeNode[] {
  const root = emptyDir();
  const outside: ChangedFile[] = [];

  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const rel = toWorkspaceRel(workspace, file.path);
    if (rel === null) {
      outside.push(file);
      continue;
    }
    const segs = rel.split("/");
    const name = segs.pop();
    if (name === undefined || name === "") continue;
    let dir = root;
    for (const seg of segs) {
      let next = dir.dirs.get(seg);
      if (next === undefined) {
        next = emptyDir();
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.files.set(name, file);
  }

  const out: FileTreeNode[] = [];
  walk(root, "", "", 0, out);
  // 区外的排在最后:它们不属于那棵树,但仍然是这次改动的一部分,不能不说
  for (const file of outside) {
    out.push({ ...leaf(file.path, file), path: file.path, name: file.path, depth: 0 });
  }
  return out;
}

/** 一个文件节点的公共部分。行数只在真有的时候带上——`additions: undefined`
    和"没有这个键"在 toEqual 里不是一回事,单测会为此吵架 */
function leaf(path: string, file: ChangedFile): FileTreeNode {
  return {
    path,
    name: path,
    depth: 0,
    kind: "file",
    full: file.path,
    ...(file.additions === undefined ? {} : { additions: file.additions }),
    ...(file.deletions === undefined ? {} : { deletions: file.deletions }),
  };
}

/** 目录优先、再文件，各自按名字（Map 的插入序已经是排过的路径序）。
    prefix = 已经压进上一行的那几段，用来算展示名和唯一键 */
function walk(dir: Dir, prefix: string, label: string, depth: number, out: FileTreeNode[]): void {
  // 独生目录链：这一层只有一个子目录、且没有文件 → 不单独占一行，压进下一段
  if (dir.dirs.size === 1 && dir.files.size === 0) {
    const [name, only] = [...dir.dirs.entries()][0]!;
    const nextPrefix = prefix === "" ? name : `${prefix}/${name}`;
    walk(only, nextPrefix, label === "" ? name : `${label}/${name}`, depth, out);
    return;
  }
  // 压过的那一段自己占一行（根目录没有名字，不画）
  const childDepth = label === "" ? depth : depth + 1;
  if (label !== "") out.push({ path: prefix, name: label, depth, kind: "folder" });

  for (const [name, sub] of dir.dirs) {
    const nextPrefix = prefix === "" ? name : `${prefix}/${name}`;
    walk(sub, nextPrefix, name, childDepth, out);
  }
  for (const [name, file] of dir.files) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    out.push({ ...leaf(path, file), name, depth: childDepth });
  }
}
