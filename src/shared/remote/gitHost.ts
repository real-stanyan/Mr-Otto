// gitHost —— Git 凭据按「工作区 + 主机」存，这里是那个「主机」的判据（#1103）。
//
// **两端共用一份**（同 wire.ts 的纪律）：桌面在输入框旁边即时说人话，服务端在
// 落盘前自己再判一次——渲染层不是安全边界，一个改造过的客户端可以直接发一条
// 上来（同 validateRepoUrl 注释里那条理由）。
//
// 为什么键是主机而不是仓库：git 自己就是按 host 匹配 credential 的（`git
// credential approve` 那套协议里 host 是主键），按仓库存等于在 git 的模型之上
// 再造一个，而那一层的唯一效果是「换个仓库就要重配一次 token」。

/** 规范化一个主机名：小写、去掉前后空白与结尾的点。
    **不动端口**——`github.example.com:8443` 与 `github.example.com` 是两台机器，
    合并它们等于让一把 token 悄悄用在另一个地方去。 */
export function normalizeGitHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, "");
}

/** 主机名的结构化校验。**刻意不做黑名单**（同 validateRepoUrl 的理由：输入校验
    做不完美，#821 被绕过三轮），只问 URL 解析器自己答得上来的问题。

    容忍两种写法：光主机名（`github.com`）和整条 https URL（`https://github.com/`）
    ——后者是人从地址栏复制过来的最常见形态，把它判成错误只会让人自己去掉前缀
    再贴一次，而我们本来就要把它归一化成主机名。 */
export function validateGitHost(raw: string): { ok: true; host: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "主机不能为空。" };
  if (trimmed.length > 253) return { ok: false, message: "主机名太长了。" };

  // 带协议的整条 URL：交给 URL 解析器，顺便把 userinfo 挡掉
  if (trimmed.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { ok: false, message: "这不是一条能解析的地址，只填主机名就行（例如 github.com）。" };
    }
    if (parsed.protocol !== "https:") {
      return { ok: false, message: `只支持 https 的主机（收到的是 ${parsed.protocol}）。` };
    }
    // 凭据在 URL 里只能住在 userinfo。这里出现凭据 = 用户把 token 贴进了错误的框，
    // 而那一格会被存进「主机」列并显示给所有在籍成员看
    if (parsed.username !== "" || parsed.password !== "") {
      return { ok: false, message: "主机那一格里不要带用户名或 token——token 填下面那一栏。" };
    }
    if (parsed.host === "") return { ok: false, message: "这条地址里没有主机名。" };
    return { ok: true, host: normalizeGitHost(parsed.host) };
  }

  const host = normalizeGitHost(trimmed);
  // 用 URL 解析器判「它是不是一个合法主机」，不自己写正则：主机名的合法形态
  // （IDN、IPv6 字面量、端口）比一条正则能覆盖的多，而解析器就在手边
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    return { ok: false, message: "这不像一个主机名（例如 github.com）。" };
  }
  if (parsed.host !== host) {
    // 解析器把它改写了 = 用户填的不是纯主机名（带了路径、查询串之类）
    return { ok: false, message: "只填主机名，不要带路径（例如 github.com，不是 github.com/acme）。" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "主机那一格里不要带用户名或 token——token 填下面那一栏。" };
  }
  return { ok: true, host };
}

/** 从一条 https 仓库地址反查它属于哪台主机——`clone_repo` 拿它去凭据表里取 token。
    解析不出来回 null（调用方据此当「没有凭据」处理，而不是猜一个）。 */
export function hostOfRepoUrl(repoUrl: string): string | null {
  try {
    const parsed = new URL(repoUrl.trim());
    return parsed.host === "" ? null : normalizeGitHost(parsed.host);
  } catch {
    return null;
  }
}
