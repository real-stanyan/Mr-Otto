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
//
// 复审 Critical（fix round，两个实测绕过）：上一版解析失败（`catch`）直接回
// false，等于判定"解析不出=没有凭据"，方向反了——`new URL()` 对「缺 scheme」
// 「scp 语法（git@host:path）」「端口非法」这些畸形字符串一律抛异常，而这些
// 恰恰是最像"把 token 当用户名手写在地址前面"的输入：
//   repoUrlHasEmbeddedCredential("token@github.com/x/y.git")            曾经 false（漏写 https:// 前缀）
//   repoUrlHasEmbeddedCredential("ghp_realtoken123@github.com:x/y.git") 曾经 false（scp 语法，token 冒充 SSH 用户名）
//   repoUrlHasEmbeddedCredential("http://git@github.com:x/y.git")       曾经 false（端口非法致整体抛异常）
// 现在解析失败一律再跑一遍保守的字符串级兜底（hasAtBeforeFirstSlash）：
// 剥掉可能存在的 `scheme://` 前缀之后，只要剩下的部分里有 @ 出现在第一个
// / 之前（或者压根没有 /），一律判 true——宁可错拦，不能放过。
//
// scp 语法（`git@github.com:x/y.git`）本身不一定是"凭据"（`git` 是 SSH 的
// 固定用户名，不是秘密），但裁决是照样一律拦：runtime 侧的 clone 走
// `git credential approve` 那一整套（sandbox.ts），沙箱里压根没配 SSH key，
// 这种 URL 在这个系统里本来就永远 clone 不成功——与其放它提交上去、跑一趟、
// 失败、再把原串广播出去，不如在输入框就拦下来。这不是"放宽"判据去多抓
// 一类无害输入，是"这个系统根本不支持 SSH"这个事实决定了 scp 语法只有两种
// 可能：要么是走错地方的 token，要么是注定失败的请求，两种都值得在提交前
// 挡住。

/** 剥掉一个形如 `scheme://` 的前缀（如果有的话）。给 hasAtBeforeFirstSlash
    兜底用：`http://git@github.com:x/y.git` 这种因端口非法整体抛异常的字符串，
    "第一个 /" 如果不跳过 scheme 自带的那个 `//`，会把 @ 误判成"在 / 之后"
    从而漏判——先剥掉 scheme 前缀，再找真正意义上的"权威部分/路径"分界 */
function stripSchemePrefix(s: string): string {
  return s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
}

/** 解析失败时的保守兜底：字符串（剥掉 scheme 前缀之后）里存在 @，且这个
    @ 出现在第一个 / 之前（或者压根没有 /），一律判"像是把凭据/SSH 用户名
    拼在地址前面"。牺牲精确度换安全——宁可多拦一些其实只是手误打错的字符串，
    也不能放过 `ghp_xxx@github.com:x/y.git` 这种 token 冒充 SSH 用户名的
    真实输入 */
function hasAtBeforeFirstSlash(s: string): boolean {
  const rest = stripSchemePrefix(s);
  const atIdx = rest.indexOf("@");
  if (atIdx === -1) return false;
  const slashIdx = rest.indexOf("/");
  return slashIdx === -1 || atIdx < slashIdx;
}

/** URL 的 userinfo（username 和/或 password）非空，就是把凭据拼进了地址里
    （`user:pass@host` 或 `<token>@host` 两种形态，解出来分别是
    username="user"/password="pass" 和 username="<token>"/password=""）。
    能被 WHATWG URL 正常解析出来的情况用 URL() 判——`https://github.com/x/y@z`
    这种"@ 出现在 path 里"的合法地址不该被误伤，URL() 按 authority 边界解析，
    不会把 path 里的 @ 认成 userinfo。解析失败（缺 scheme、scp 语法、端口
    非法……）绝不能退到"没有凭据"——见文件头"复审 Critical"那段，改用
    hasAtBeforeFirstSlash 的保守兜底，拦下来比放过去安全 */
export function repoUrlHasEmbeddedCredential(repoUrl: string): boolean {
  try {
    const u = new URL(repoUrl);
    return u.username !== "" || u.password !== "";
  } catch {
    return hasAtBeforeFirstSlash(repoUrl);
  }
}

/** 挡下来之后给人看的提示——统一措辞，Dialog 直接用，不各自现造一句。
    两句话缺一不可（复审 Critical 附带要求）：① 万一真是 token，该填的地方
    是 PAT 栏，不是地址栏；② 就算不是 token、只是习惯了 SSH 写法
    （`git@host:path`），这个云沙箱也用不了——runtime 侧只配了 https 的
    一次性凭据（git credential approve），没有任何 SSH key，SSH 形式的地址
    在这个系统里注定 clone 不成功，不是"暂时不支持"那种以后会通的话，用户
    得知道换成 https 地址，不是去别处找 SSH key 配置入口 */
export const EMBEDDED_CREDENTIAL_MESSAGE =
  "这个地址看起来带了用户名或 token（如 https://<token>@github.com/... 或 git@github.com:x/y.git）。" +
  "如果是 token，请填到下面的 Personal Access Token 栏，地址只填不带凭据的那一段；" +
  "云沙箱只支持 https:// 形式的仓库地址，不支持 SSH（git@... 写法）。";
