// skill 卡片的文案 —— 纯函数，主/渲两侧共用（渲染层不该自己拼这套话术，
// 两处各写一份文案迟早 drift）。

/** 启用卡片的一行标题。模型自取的（source: "model"）标出来源——用户得知道
    上下文里这份说明书是谁塞的；用户 $ 启用的（缺省/"user"）不标，跟旧日志
    投影逐字节一致 */
export function skillCardLabel(e: {
  name: string;
  args?: string;
  source?: "user" | "model";
}): string {
  const who = e.source === "model" ? "Otto 启用了" : "已启用";
  const args = e.args ? `（参数：${e.args}）` : "";
  return `${who} skill「${e.name}」${args}`;
}

/** 停用那一行的文案。停用不标来源：用户点的按钮和模型自己 release 的，
    结果都是"这把 skill 不再生效"，是谁按的停止键不改变这句话说的事实
    （谁把它塞进来的才需要标——那是 skillCardLabel 的事）。
    单独一个函数而不是让两处 UI 各写一遍：聊天区（Timeline 的 EventRow）和
    轨迹视图（replay/trajectory）现在都在说这句话，两份文案迟早 drift */
export function skillReleasedLabel(e: { name: string }): string {
  return `已停用 skill「${e.name}」`;
}
