// 工作区云仓库配置——repo URL 里不许带凭据（issue #821 slice 2）。
//
// runtime 侧的 redactPat()（services/runtime/src/sandbox.ts）只脱敏经由
// 单独 PAT 字段传下去的那份 token；用户如果把 token/密码直接拼进 URL 里
// （`https://<token>@github.com/x/y.git` 或 `https://user:pass@host/...`），
// redactPat 认不出这种形态——这个 token 会原样出现在 clone 结果的通报文案里
// （services/runtime/src/daemon.ts 的 onCloneResult：
// `仓库克隆成功：${result.repoUrl}` / 失败同理拼进 reason 前面那句），
// 而这条消息会广播给整个工作区的所有成员，不只是配置它的 owner 自己看得到。
// 挡在渲染层提交前，比等 runtime 报错再脱敏更早、更彻底——网络包里就不该
// 出现这种 URL。

/** URL 的 userinfo（username 和/或 password）非空，就是把凭据拼进了地址里
    （`user:pass@host` 或 `<token>@host` 两种形态，解出来分别是
    username="user"/password="pass" 和 username="<token>"/password=""）。
    用 WHATWG URL 解析而不是手写正则——`https://github.com/x/y@z` 这种
    "@ 出现在 path 里"的合法地址不该被误伤，URL() 按 authority 边界解析，
    不会把 path 里的 @ 认成 userinfo。解析不出的字符串（比如
    `git@github.com:x/y.git` 这种 scp 语法，或空串）不是这个函数要管的
    "合不合法"，交给别处判断，这里只回答"看得出凭据吗"，看不出就回 false */
export function repoUrlHasEmbeddedCredential(repoUrl: string): boolean {
  try {
    const u = new URL(repoUrl);
    return u.username !== "" || u.password !== "";
  } catch {
    return false;
  }
}

/** 挡下来之后给人看的提示——统一措辞，Dialog 直接用，不各自现造一句 */
export const EMBEDDED_CREDENTIAL_MESSAGE =
  "仓库地址里不能带用户名或 token（如 https://<token>@github.com/...）。" +
  "把凭据填到下面的 Personal Access Token 栏，仓库地址只填不带凭据的那一段。";
