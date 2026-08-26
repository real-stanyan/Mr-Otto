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

export interface FileTreeNode {
  /** 树里的唯一键 = 展示路径（工作区相对；区外文件就是绝对路径） */
  path: string;
  /** 这一行显示的字：目录是压过的那一段，文件是文件名 */
  name: string;
  depth: number;
  kind: "folder" | "file";
  /** 文件才有：点它要打开的那个路径（原样，绝对） */
  full?: string;
}

/** 内部搭树用的可变节点。目录的 children 用 Map 保插入序 */
interface Dir {
  dirs: Map<string, Dir>;
  files: Map<string, string>; // 展示名 → 原始绝对路径
}

const emptyDir = (): Dir => ({ dirs: new Map(), files: new Map() });

/**
 * @param paths 这一组动过的文件（绝对路径，调用方已去重）
 * @param workspace 当前会话的工作区。空串 = 没有工作区，所有路径按区外处理
 */
export function fileTreeNodes(
  paths: readonly string[],
  workspace: string
): FileTreeNode[] {
  const root = emptyDir();
  const outside: string[] = [];

  for (const abs of [...paths].sort()) {
    const rel = toWorkspaceRel(workspace, abs);
    if (rel === null) {
      outside.push(abs);
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
    dir.files.set(name, abs);
  }

  const out: FileTreeNode[] = [];
  walk(root, "", "", 0, out);
  // 区外的排在最后:它们不属于那棵树,但仍然是这次改动的一部分,不能不说
  for (const abs of outside.sort()) {
    out.push({ path: abs, name: abs, depth: 0, kind: "file", full: abs });
  }
  return out;
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
  for (const [name, abs] of dir.files) {
    out.push({
      path: prefix === "" ? name : `${prefix}/${name}`,
      name,
      depth: childDepth,
      kind: "file",
      full: abs,
    });
  }
}
