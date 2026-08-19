// profile — 多开时的数据隔离。
//
// userData 目录默认钉死在 mr-otto（见 index.ts 的注释：改 app.name 会让老数据
// 凭空消失）。但一台机器上要同时登两个账号时，两个实例共用一个目录 =
// 共用 auth.json 与 sessions.db，后登录的会盖掉先登录的。
//
// OTTO_PROFILE=b 把目录换成 mr-otto-b。不设就是原来的 mr-otto，老用户无感。

/** 目录名里只放这些字符——它要拼进文件系统路径，别让 ../ 之类的东西进来 */
const SAFE = /^[a-zA-Z0-9_-]+$/;

export function profileDirName(env: Record<string, string | undefined>): string {
  const raw = env["OTTO_PROFILE"];
  if (!raw) return "mr-otto";
  if (!SAFE.test(raw)) {
    throw new Error(`OTTO_PROFILE 只能是字母/数字/下划线/连字符，收到 ${JSON.stringify(raw)}`);
  }
  return `mr-otto-${raw}`;
}
