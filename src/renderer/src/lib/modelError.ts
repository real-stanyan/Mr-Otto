// 报错的**人话版**。原文照旧留在日志里(turn_ended.error 是 append-only 的事实,
// 也是排查时唯一能信的东西),这里只管显示时怎么念。
//
// 为什么在显示层做,不在抛错的地方做:各家的错误体格式随时会变,解析器认错了
// 只是这一屏念得不好听;要是在落盘前就把原文换成"人话",日志里存下的就是解析器
// 的猜测 —— 猜错了永远查不回去(硬规则:日志是唯一事实来源)。
//
// 认三层壳,一层层剥:
//   ① Electron 的 IPC 包装   "Error invoking remote method 'otter:sendMessage': Error: …"
//   ② 本仓 adapter 的包装     "model API 429: <响应体>"
//   ③ 各家的 JSON 错误体      {"error":{"code":"1113","message":"余额不足…"}}
// 剥到人写的那句话就用它 —— 服务商自己写的提示("余额不足或无可用资源包,请充值")
// 比任何我们编的转述都准。一层都剥不动就原样显示:不认识的东西不假装认识。

/** 各家没给 message 时,只能按状态码说个大概。说的是"这类失败通常是什么",不编细节 */
const BY_STATUS: Record<number, string> = {
  400: "请求被服务商拒绝（参数不合法）",
  401: "API key 无效或已过期",
  403: "这个 key 没有访问该模型的权限",
  404: "模型或接口不存在（型号 id 可能写错了）",
  408: "服务商响应超时",
  413: "请求太大了（上下文或附件超出这家的上限）",
  429: "被限流了：请求太密，或额度/资源包已用完",
  500: "服务商内部错误",
  502: "服务商网关错误",
  503: "服务商暂时不可用（过载或维护中）",
  504: "服务商网关超时",
};

/** 连不上/被掐断这一类:Node fetch 抛的字面量,不带状态码 */
const BY_PHRASE: [RegExp, string][] = [
  [/fetch failed|ENOTFOUND|EAI_AGAIN/i, "连不上服务商（网络不通，或 baseUrl 填错了）"],
  [/ECONNREFUSED/i, "连接被拒（本机服务没起来？检查 Ollama / 自建 endpoint）"],
  [/ETIMEDOUT|timeout/i, "连接超时"],
  [/certificate|self.signed/i, "TLS 证书校验失败（代理或自建 endpoint 的证书有问题）"],
];

export interface HumanError {
  /** 给人看的那一句 */
  text: string;
  /** 原文。text === raw 时说明没剥动，UI 也就不必再给"看原文"的入口 */
  raw: string;
}

/** 从各家的错误体里挖出人写的那句话。挖不到返回 null —— 不猜 */
function messageOf(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const err = (parsed as { error?: unknown; message?: unknown }).error;
  // Ollama 那种 {"error":"model not found"}
  if (typeof err === "string" && err !== "") return err;
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m !== "") return m;
  }
  // 少数家把 message 放在顶层
  const top = (parsed as { message?: unknown }).message;
  return typeof top === "string" && top !== "" ? top : null;
}

export function humanizeError(raw: string): HumanError {
  const keep = (text: string): HumanError => ({ text, raw });

  // ① Electron 的 IPC 包装：ipcRenderer.invoke 的 reject 会被裹成这一长串，
  //    "远程方法名"对读的人毫无用处，主进程原来抛的那句才是内容
  const unwrapped = raw.replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    "",
  );

  // ② 本仓 adapter 的包装（model/openaiCompatible.ts）
  const api = /^model API (\d{3}):\s*([\s\S]*)$/.exec(unwrapped);
  if (api) {
    const status = Number(api[1]);
    const body = (api[2] ?? "").trim();
    const message = messageOf(body);
    if (message !== null) return keep(message);
    // 挖不到就退回状态码的通说；连状态码都不认识时，把响应体原样带上——
    // 那时候它是唯一的信息，藏起来只会让人无从下手
    const known = BY_STATUS[status];
    return keep(known ?? `服务商返回 ${status}${body ? `：${body}` : ""}`);
  }

  // ③ 没有包装、直接就是一坨 JSON 的（少数路径）
  const bare = messageOf(unwrapped);
  if (bare !== null) return keep(bare);

  for (const [re, text] of BY_PHRASE) {
    if (re.test(unwrapped)) return keep(text);
  }

  // 一层都没剥动：原样显示。IPC 那层壳如果剥掉了，至少少一行噪音
  return { text: unwrapped, raw };
}
