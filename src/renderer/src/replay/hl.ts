// 数据卡迷你高亮器：返回 token 数组，DOM 由 <Hl> 拼。纯函数，可单测。
// 曾住在 steps.ts（旧回放的函数轨迹）；旧回放换成轨迹视图后只剩它还有人用：
// 聊天区工具详情 + 轨迹详情的 payload/result 共用一处逻辑。

export interface Tok {
  /** hk=key hs=字符串 hd=数字 hv=标识符 hw=关键字 hp=标点 hn=中文注释 ""=素色 */
  cls: string;
  text: string;
}

const TOK =
  /("(?:[^"\\]|\\.)*")|(（[^）]*）?)|(-?\d+(?:\.\d+)?)|([A-Za-z_$][\w$]*)|([{}[\]():,;=…]|→|←|✕|↓|\/)/g;
const KW = /^(true|false|null|return|await|try|catch|POST|SELECT|INSERT|UPDATE|DELETE|RAISE|ABORT|MAX)$/;

export function hl(src: string): Tok[] {
  const out: Tok[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOK.lastIndex = 0;
  while ((m = TOK.exec(src))) {
    if (m.index > last) out.push({ cls: "", text: src.slice(last, m.index) });
    const [, str, note, num, ident, punct] = m;
    const keyNext = /^\s*:/.test(src.slice(TOK.lastIndex)); // 后面跟冒号 = key
    if (str !== undefined) out.push({ cls: keyNext ? "hk" : "hs", text: str });
    else if (note !== undefined) out.push({ cls: "hn", text: note });
    else if (num !== undefined) out.push({ cls: "hd", text: num });
    else if (ident !== undefined)
      out.push({ cls: keyNext ? "hk" : KW.test(ident) ? "hw" : "hv", text: ident });
    else out.push({ cls: "hp", text: punct! });
    last = TOK.lastIndex;
  }
  if (last < src.length) out.push({ cls: "", text: src.slice(last) });
  return out;
}
