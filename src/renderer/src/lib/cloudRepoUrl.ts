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
// 复审 Critical round 1（三个实测绕过）：上一版解析失败（`catch`）直接回
// false，等于判定"解析不出=没有凭据"，方向反了——`new URL()` 对「缺 scheme」
// 「scp 语法（git@host:path）」「端口非法」这些畸形字符串一律抛异常，而这些
// 恰恰是最像"把 token 当用户名手写在地址前面"的输入：
//   repoUrlHasEmbeddedCredential("token@github.com/x/y.git")            曾经 false（漏写 https:// 前缀）
//   repoUrlHasEmbeddedCredential("ghp_realtoken123@github.com:x/y.git") 曾经 false（scp 语法，token 冒充 SSH 用户名）
//   repoUrlHasEmbeddedCredential("http://git@github.com:x/y.git")       曾经 false（端口非法致整体抛异常）
// 当时的修法：解析失败一律再跑一遍字符串级兜底——剥掉可能存在的
// `scheme://` 前缀之后，找剩下部分里有没有 @ 出现在第一个 / 之前。
//
// 复审 Critical round 2（同一个兜底自己又漏两类）：
//   repoUrlHasEmbeddedCredential("token%40github.com/x/y.git")           曾经 false（%40 编码的 @，兜底只在原串上 indexOf("@")，编码后的 @ 隐身）
//   repoUrlHasEmbeddedCredential("https://token%40github.com/x/y.git")   曾经 false（同上；这个字符串本身也让 new URL() 抛异常，一样落进兜底）
//   repoUrlHasEmbeddedCredential("//ghp_xxx@github.com/x/y.git")         曾经 false（协议相对形式，没有 scheme 标签，stripSchemePrefix 拿它没办法，
//                                                                          开头那个 / 让"第一个 /"落在位置 0，判"authority 在任何 @ 之前就结束了"）
// 根因是同一个兜底函数里把"解码"和"找边界"两件事悄悄漏掉，一层层打补丁只
// 会一直漏下一类。现在改成显式的、有名字的归一化流水线（每步独立可测）：
// trim → 尽力 percent-decode 到不动点 → 剥 scheme → 剥所有前导 / → 在结果里
// 找"第一个 / 之前有没有 @"。
//
// scp 语法（`git@github.com:x/y.git`）本身不一定是"凭据"（`git` 是 SSH 的
// 固定用户名，不是秘密），但裁决是照样一律拦：runtime 侧的 clone 走
// `git credential approve` 那一整套（sandbox.ts），沙箱里压根没配 SSH key，
// 这种 URL 在这个系统里本来就永远 clone 不成功——与其放它提交上去、跑一趟、
// 失败、再把原串广播出去，不如在输入框就拦下来。这不是"放宽"判据去多抓
// 一类无害输入，是"这个系统根本不支持 SSH"这个事实决定了 scp 语法只有两种
// 可能：要么是走错地方的 token，要么是注定失败的请求，两种都值得在提交前
// 挡住。

/** 归一化流水线用的迭代上限——纯防御性写法。正常输入（含恶意的双重/三重
    编码）会在个位数次迭代内收敛到不动点，这个数字只是不让一个理论上的
    病态输入把循环拖到失控 */
const MAX_DECODE_ITERATIONS = 10;

/** 尽力 percent-decode 到不动点。单次 decodeURIComponent 只剥一层——
    `%2540` 解一次是 `%40`，看不出还藏着一个 @，必须循环解到"再解一次也
    不变"为止才能找到 `%2540` → `%40` → `@` 这种双重编码。decodeURIComponent
    对不合法的 %xx 序列（比如字符串里恰好有个 "%zz"）会抛 URIError——那种
    情况就地停手，用目前已经解出来的这一步结果："尽力"不等于"必须完全
    解码成功"，停在半路好过因为一处不合法序列就放弃整个检测 */
function bestEffortDecode(s: string): string {
  let cur = s;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** 剥掉一个形如 `scheme://` 的前缀（如果有的话）。`http://git@github.com:x/y.git`
    这种因端口非法整体抛异常的字符串，"第一个 /" 如果不跳过 scheme 自带的
    那个 `//`，会把 @ 误判成"在 / 之后"从而漏判——先剥掉 scheme 前缀，
    再找真正意义上的"权威部分/路径"分界 */
function stripSchemePrefix(s: string): string {
  return s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
}

/** 剥掉所有前导 /。协议相对形式（`//host/path`）和它的变体（`///host/path`）
    没有 scheme 标签，stripSchemePrefix 拿它没办法，会原样剩下开头的 /，
    导致"第一个 /"落在位置 0，判"authority 在任何 @ 之前就结束了"从而
    漏判——这是"漏写 https://"这一族绕过的另一种写法，用 // 而不是完全
    不写 */
function stripLeadingSlashes(s: string): string {
  return s.replace(/^\/+/, "");
}

/** 解析失败时的归一化流水线：依次 trim → 尽力 percent-decode 到不动点 →
    剥 scheme → 剥所有前导 /。每一步单独命名、单独可测——round 1 把"剥
    scheme"和"找边界"拧在一个函数里，round 2 就在同一个函数里又漏了解码
    和协议相对形式两类；拆开写是为了不再在一个函数体内悄悄漏掉下一类
    形态，新增一类绕过时应该是新增一步或修一步，而不是在混在一起的逻辑里
    再插一个特判 */
function normalizeForCredentialScan(raw: string): string {
  const trimmed = raw.trim();
  const decoded = bestEffortDecode(trimmed);
  const withoutScheme = stripSchemePrefix(decoded);
  return stripLeadingSlashes(withoutScheme);
}

/** 解析失败时的保守兜底：归一化后的字符串里存在 @，且这个 @ 出现在第一个
    / 之前（或者压根没有 /），一律判"像是把凭据/SSH 用户名拼在地址前面"。
    牺牲精确度换安全——宁可多拦一些其实只是手误打错的字符串，也不能放过
    `ghp_xxx@github.com:x/y.git` 或 `token%40github.com/x/y.git` 这类真实
    输入 */
function hasAtBeforeFirstSlash(s: string): boolean {
  const normalized = normalizeForCredentialScan(s);
  const atIdx = normalized.indexOf("@");
  if (atIdx === -1) return false;
  const slashIdx = normalized.indexOf("/");
  return slashIdx === -1 || atIdx < slashIdx;
}

/** URL 的 userinfo（username 和/或 password）非空，就是把凭据拼进了地址里
    （`user:pass@host` 或 `<token>@host` 两种形态，解出来分别是
    username="user"/password="pass" 和 username="<token>"/password=""）。
    能被 WHATWG URL 正常解析出来的情况用 URL() 判——`https://github.com/x/y@z`
    这种"@ 出现在 path 里"的合法地址不该被误伤，URL() 按 authority 边界解析，
    不会把 path 里的 @ 认成 userinfo。解析失败（缺 scheme、scp 语法、端口
    非法、编码过的 @、协议相对形式……）绝不能退到"没有凭据"——见文件头两轮
    "复审 Critical"，改用 hasAtBeforeFirstSlash 的保守兜底，拦下来比放过去
    安全 */
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
