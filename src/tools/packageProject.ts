// package_project — 把 Default 工作区里的产出打包成一个项目(#559 后续)。
//
// 只挂在带 projects 能力的装配上(= 内置 Default 工作区的主会话,index.ts 注入);
// 项目会话/子会话没有这把刀。它是唯一一把故意越出围栏的工具——落点在
// 文档区 Mr Otto/<名字>,不在 workspace 内——所以 requiresApproval 不是可选项:
// 审批卡上的 name + files 全清单就是这条路上的安全闸(实现侧的路径校验
// 见 main/projectPackager.ts)。
//
// 输出是纯 JSON:渲染层认这个工具名,把 tool_result 解析成「项目已打包」卡
// (带「在新项目开会话」按钮),模型也能照着复述落点。

import type { Tool } from "./tool.js";

export const packageProjectTool: Tool = {
  def: {
    name: "package_project",
    description:
      "把当前 Default 工作区里的指定文件/文件夹搬进一个新项目文件夹（文档区 Mr Otto/<项目名>）。" +
      "只在用户同意打包后调用；files 是相对工作区的路径清单，没点名的不动",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "项目名（纯文件夹名，不能带路径分隔符）" },
        files: {
          type: "array",
          items: { type: "string" },
          description: "要搬进项目的文件/文件夹（相对工作区路径），至少一项",
        },
      },
      required: ["name", "files"],
    },
  },
  requiresApproval: true,

  async run(args, world) {
    if (!world.projects) {
      throw new Error("这个会话没有打包能力——只有 Default 工作区的会话能打包项目");
    }
    const a = args as { name?: unknown; files?: unknown };
    if (typeof a.name !== "string" || a.name.trim() === "") {
      throw new Error("package_project: 参数 name 必须是非空字符串");
    }
    if (!Array.isArray(a.files) || a.files.some((f) => typeof f !== "string")) {
      throw new Error("package_project: 参数 files 必须是字符串数组");
    }
    const r = await world.projects.packageProject(a.name, a.files as string[]);
    return JSON.stringify(r);
  },
};
