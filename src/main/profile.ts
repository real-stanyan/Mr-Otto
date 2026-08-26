// profile — 多开时的数据隔离。
//
// userData 目录默认钉死在 mr-otto（见 index.ts 的注释：改 app.name 会让老数据
// 凭空消失）。但一台机器上要同时登两个账号时，两个实例共用一个目录 =
// 共用 auth.json 与 sessions.db，后登录的会盖掉先登录的。
//
// OTTO_PROFILE=b 把目录换成 mr-otto-b。不设就是原来的 mr-otto，老用户无感。

/** 目录名里只放这些字符——它要拼进文件系统路径，别让 ../ 之类的东西进来 */
const SAFE = /^[a-zA-Z0-9_-]+$/;

export function profileDirName(
  env: Record<string, string | undefined>,
  isPackaged = true,
): string {
  const raw = env["OTTO_PROFILE"];
  if (!raw) {
    // dev 模式(未打包)默认走独立目录:不然和生产版抢同一个 mr-otto 的单实例锁,
    // 抢不到就静默退出——「生产版开着时 dev 打不开」。OTTO_PROFILE 显式指定优先
    return isPackaged ? "mr-otto" : "mr-otto-dev";
  }
  if (!SAFE.test(raw)) {
    throw new Error(`OTTO_PROFILE 只能是字母/数字/下划线/连字符，收到 ${JSON.stringify(raw)}`);
  }
  return `mr-otto-${raw}`;
}
