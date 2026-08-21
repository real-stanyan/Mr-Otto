// repoKey — 把 git remote URL 归一成"同一个仓库就相同"的字符串(issue #167)。
// ssh / https / 带不带 .git / 大小写 / 尾斜杠,都该指向同一把 key。
// 这里只做规范化,不做 hash:hash 需要 crypto,留在主进程(shared 三边共 import)。

/**
 * 规范化 remote URL → `host/owner/repo`(全小写)。认不出形状返回 null。
 *
 * 支持:
 *   git@github.com:owner/repo.git
 *   ssh://git@github.com/owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://user:token@github.com/owner/repo
 *   github.com/owner/repo
 */
export function normalizeRemoteUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  // scp 风格 git@host:path —— 没有 "://",冒号后面直接是路径
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/.exec(s);
  if (scp) {
    return join(scp[1]!, scp[2]!);
  }

  // 有协议的:剥协议和 user:pass@
  const proto = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(s);
  if (proto) s = proto[1]!;
  s = s.replace(/^[^@/]+@/, "");

  const slash = s.indexOf("/");
  if (slash <= 0) return null;
  return join(s.slice(0, slash), s.slice(slash + 1));
}

function join(host: string, path: string): string | null {
  const h = host.replace(/:\d+$/, "").toLowerCase();
  let p = path.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/^\/+/, "");
  if (!h || !p) return null;
  p = p.toLowerCase();
  return `${h}/${p}`;
}
