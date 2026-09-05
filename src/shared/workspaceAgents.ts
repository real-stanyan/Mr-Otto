// workspaceAgents —— 工作区 agent 表单的纯校验（#932 切片 1b）。
// 桌面设置页用；手机端将来做同一张表单时 import 同一份（纪律同 workspaces.ts）。
// DB 那侧的约束（0021：name 1–32 字符、一个工作区不重名）在这里对齐成能提前
// 说出口的人话；重名靠 23505 回来再翻，这里判不了。

export const AGENT_NAME_MAX = 32;

export function validateAgentName(raw: string): string | null {
  const name = raw.trim();
  if (name.length === 0) return "名字不能为空";
  if (name.length > AGENT_NAME_MAX) return `名字最多 ${AGENT_NAME_MAX} 个字符`;
  if (name.includes("@")) return "名字里不能有 @——它是点名用的前缀";
  if (/[\r\n]/.test(name)) return "名字不能换行";
  return null;
}

export function parseModelList(raw: string): string[] {
  const out: string[] = [];
  for (const piece of raw.split(/[,，]/)) {
    const m = piece.trim();
    if (m !== "" && !out.includes(m)) out.push(m);
  }
  return out;
}
