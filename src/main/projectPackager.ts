// 打包为项目(#559 后续):把内置 Default 工作区里的产出搬进 文档区/Mr Otto/<名字>。
//
// 这是唯一一把**故意越出围栏**的工具能力——落点不在 workspace 里,所以走不了
// world.fs。主进程模块直接用 node:fs(硬规则圈的是工具实现,不是这里),
// 由 index.ts 包成 ProjectsCapability 只焊给内置 Default 工作区的主会话;
// 模型侧的 package_project 工具 requiresApproval,审批卡列全参数是安全闸。
//
// 安全边界(tests/main/projectPackager.test.ts 钉死):
// - name 是纯文件夹名:含路径分隔符 / "." / ".." / 空白 = 拒
// - files 逐个 resolve,必须落在 workspace 内(路径穿越拒)
// - 目标已存在 = 拒(别把两个项目搅在一起)
// - 校验全过才动第一个文件(名单里有一个坏的,整单不搬)

import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export async function packageProject(args: {
  documentsDir: string;
  workspace: string;
  name: string;
  files: string[];
}): Promise<{ dir: string; moved: string[] }> {
  const name = args.name.trim();
  if (!name || name === "." || name === ".." || /[/\\]/.test(name)) {
    throw new Error(`项目名只能是一个文件夹名（收到 ${JSON.stringify(args.name)}）——不能带路径`);
  }
  if (args.files.length === 0) {
    throw new Error("files 是空的——先说清要把哪些产出搬进项目");
  }
  const wsRoot = resolve(args.workspace);
  // 先把整单校验完再动手:搬到一半发现越界,工作区就成了半拆的家
  const sources = args.files.map((f) => {
    const abs = resolve(wsRoot, f);
    if (abs !== wsRoot && !abs.startsWith(wsRoot + sep)) {
      throw new Error(`「${f}」不在工作区内——只能打包这个工作区里的文件`);
    }
    if (abs === wsRoot) {
      throw new Error("不能把整个工作区打包成项目——点名要搬的文件/文件夹");
    }
    if (!existsSync(abs)) {
      throw new Error(`「${f}」不存在——检查文件名`);
    }
    return { rel: f, abs };
  });
  const dir = join(args.documentsDir, "Mr Otto", name);
  if (existsSync(dir)) {
    throw new Error(`项目「${name}」已存在（${dir}）——换个名字，或让用户手动合并`);
  }
  await mkdir(dir, { recursive: true });
  for (const s of sources) {
    const target = join(dir, s.rel);
    // 子路径(如 site/index.html)得先有父目录;rename 不会自己造
    await mkdir(resolve(target, ".."), { recursive: true });
    try {
      await rename(s.abs, target);
    } catch {
      // 跨盘(EXDEV)或其它 rename 搬不动的情形:退化成 拷贝+删源
      await cp(s.abs, target, { recursive: true });
      await rm(s.abs, { recursive: true });
    }
  }
  return { dir, moved: sources.map((s) => s.rel) };
}
