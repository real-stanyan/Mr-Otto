// secretEnv —— "哪些 process.env 变量是 otter 自己塞进去的凭据"的登记处。
//
// 为什么需要这么一份名单：keyVault 把用户配的 API key **明文**写进
// process.env（`applyToEnv`），模型 adapter 从那里取用。而 LocalWorld 起
// 子进程（bash 的 exec、终端的 pty）时默认整份继承 process.env——于是
// agent 自己的一句 `echo $DEEPSEEK_API_KEY` 就能把用户的 key 读出来，
// 再一句 curl 就能把它送走（issue #153）。
//
// 直接剥光子进程的环境不是答案：用户的 PATH / nvm / 语言设置都在 process.env
// 里，剥干净了那个终端就不是"他自己的终端"。所以剥的必须是**精确的一份名单**——
// otter 注入的那些，不是用户自己环境里本来就有的那些。
//
// 登记发生在写入的同一行（keyVault.applyToEnv），名单因此不会和真实注入 drift。
// 纯内存、纯字符串，没有 fs——放 shared 是因为写入方（src/main）和剥离方
// （src/world）分居两侧，shared 是它们唯一的共同祖先。

const injected = new Set<string>();

/** 记一笔：这个环境变量的值是 otter 注入的凭据，不该跟着子进程出去 */
export function markSecretEnv(name: string): void {
  injected.add(name);
}

/** 撤销登记（用户在设置页清空了这把 key）。删掉之后它就是一个普通变量了 */
export function unmarkSecretEnv(name: string): void {
  injected.delete(name);
}

/** 此刻的名单快照。每次起子进程前现问一次——名单会随用户在设置页的操作变 */
export function secretEnvNames(): readonly string[] {
  return [...injected];
}

/** 从一份环境里摘掉登记在案的凭据。传入的对象不被改动（子进程环境是一次性的拷贝）。
    `names` 可注入，测试不必碰全局登记处 */
export function stripSecretEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[] = secretEnvNames()
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }
  for (const name of names) delete out[name];
  return out;
}
