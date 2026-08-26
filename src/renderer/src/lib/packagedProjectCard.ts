// package_project 的 tool_result 解析(#559 后续)——时间线上那张「项目已打包」卡
// 的纯逻辑半边。形状不对返回 null,卡退回通用工具行(半张卡比没有卡更糟,
// 同 askUserCard 的立场)。

export interface PackagedProject {
  dir: string;
  moved: string[];
}

export function parsePackageProjectResult(raw: string): PackagedProject | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== "object") return null;
    const o = v as Record<string, unknown>;
    if (typeof o["dir"] !== "string" || o["dir"] === "") return null;
    if (!Array.isArray(o["moved"]) || o["moved"].some((m) => typeof m !== "string")) return null;
    return { dir: o["dir"], moved: o["moved"] as string[] };
  } catch {
    return null;
  }
}

/** 路径最后一段当项目名(Windows 反斜杠也认,同 WorkspaceSettings 的 workspaceName) */
export function packagedProjectName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir;
}
