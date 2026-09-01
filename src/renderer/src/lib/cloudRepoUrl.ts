// 工作区云仓库配置——repo URL 里像不像嵌了凭据（issue #821 slice 2）。
//
// 定位变更（复审 round 3，架构判定）：这个函数**从此不是安全防线，只是
// 提交前的早期 UX 提示**——帮用户在填错的那一刻就发现（手滑把 token 拼进
// 了地址栏，或者不知道这个云沙箱不支持 SSH），比等 runtime 跑一趟 clone
// 失败再回头改更省事。真正的安全防线搬到了输出侧：runtime 侧 clone 结果
// 通报改成只发脱敏摘要（`safeRepoLabel`，另一刀在做），不再原样回显
// repoUrl——不管这个函数漏判了什么形态，广播给工作区全员的消息里都不会
// 出现原始 repoUrl。**这里的一处漏判，不等于一次凭据泄漏**；下一班改这个
// 文件时不必再把每一条正则/归一化步骤当成最后一道闸去死磕。
//
// 下面 round 1/round 2/round 3 的绕过记录仍然保留——不是"这里还欠安全债"，
// 是这个检测本身怎么一步步从"能用"变成"讲得清道理"的过程，帮下一个改动
// 的人别在同一处再摔一次：
//
// 背景（原始动机，出这个函数之前的样子）：runtime 侧的 redactPat()
// （services/runtime/src/sandbox.ts）只脱敏经由单独 PAT 字段传下去的那份
// token；用户如果把 token/密码直接拼进 URL 里（`https://<token>@github.com/x/y.git`
// 或 `https://user:pass@host/...`），redactPat 认不出这种形态。挡在渲染层
// 提交前，比等 runtime 报错再脱敏更早——这条动机现在部分被 safeRepoLabel
// 取代（见上面"定位变更"），但"提前告诉用户填错了"这个 UX 价值还在。
//
// 复审 Critical round 1（三个实测绕过）：最早一版解析失败（`catch`）直接回
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
// 修法：加 percent-decode 到不动点 + 剥所有前导 /，拆成显式的、有名字的
// 归一化步骤（每步独立可测），不再在一个函数体里悄悄漏掉下一类形态。
//
// 复审 round 3（两类更进一步的绕过，但审查已改判这个函数不再是安全边界，
// 收这两条纯粹因为修起来便宜、且第一类可能是无意产生的）：
//   repoUrlHasEmbeddedCredential("ghp_realtoken＠github.com/x/y.git")     曾经 false（全角＠ U+FF20——中文输入法全角标点模式下可能无意产生，不只是攻击串）
//   repoUrlHasEmbeddedCredential("ghp_x﹫github.com/x/y.git")            曾经 false（小型﹫ U+FE6B，同上一类）
//   （11 层以上嵌套 percent-encoding）                                   曾经 false（MAX_DECODE_ITERATIONS 到顶后静默返回当前状态，等于"放行"）
// 修法两条：① 归一化流水线在 percent-decode 之后加一步 NFKC 折叠
// （`.normalize("NFKC")`，把全角/小型变体折成 ASCII @）；② 解码循环到顶
// （跑满 MAX_DECODE_ITERATIONS 仍未收敛到不动点）不再静默返回当前解码
// 结果，改成直接判 true——"不知道还有没有更深的编码层"和"没看出凭据"是
// 两件事，前者不该被当成后者。上限本身留 10，改的是到顶的语义（放行→拦），
// 不是把数字调大——调大只是把同一个漏洞往后挪一轮，round 3 就是在验证
// "调大治标不治本"这个判断。
//
// 有意不做的事（round 3 明确收工，不是没想到）：decodeURIComponent 因
// 不合法 %xx 序列而抛出 URIError 那条分支仍然是"用当前已解出的结果"而不是
// fail-closed——这理论上也能被构造出"合法 %40 与一个无关的非法 %zz 拼在
// 同一串里，让整次 decode 失败从而漏判"这种绕过，但没有被要求修（复审这
// 一轮明确划了范围：全角/小型 @ 和解码到顶两条），且这个函数的定位已经
// 降级为 UX 提示，真正的闸在 safeRepoLabel。继续在这一层加码不是这一刀
// 该做的事。

/** 归一化流水线用的迭代上限。round 3 之前是"纯防御性写法，正常输入几层
    内必然收敛"；round 3 之后多了一层含义：这也是"到顶就判定可疑"这条
    fail-closed 规则的触发线——数字本身可以调（10 或 20 都行，复审原话），
    真正要紧的是到顶之后怎么处理，见 bestEffortDecode 的返回类型 */
const MAX_DECODE_ITERATIONS = 10;

/** bestEffortDecode 的结果：converged=false 表示循环跑满
    MAX_DECODE_ITERATIONS 仍未到不动点——不知道字符串里还有没有更深的
    编码层，不能装作已经看到底。converged=true 才带着解出来的 value，
    调用方据此分别处理"看清楚了"和"没看清楚"两种情况，不能把两种情况
    混成同一个返回值（round 3 之前的版本正是把"没看清楚"悄悄混进了正常
    返回，才会在跑满上限时静默放行） */
type DecodeOutcome = { converged: true; value: string } | { converged: false };

/** 尽力 percent-decode 到不动点。单次 decodeURIComponent 只剥一层——
    `%2540` 解一次是 `%40`，看不出还藏着一个 @，必须循环解到"再解一次也
    不变"为止才能找到 `%2540` → `%40` → `@` 这种双重编码。decodeURIComponent
    对不合法的 %xx 序列（比如字符串里恰好有个 "%zz"）会抛 URIError——那种
    情况就地停手，用目前已经解出来的这一步结果："尽力"不等于"必须完全
    解码成功"，停在半路好过因为一处不合法序列就放弃整个检测（round 3 没有
    改这一条分支——见文件头"有意不做的事"）。跑满迭代上限仍未收敛才是
    round 3 新增的 fail-closed 分支：那种情况不返回任何"半成品"字符串，
    直接告诉调用方"没看清楚" */
function bestEffortDecode(s: string): DecodeOutcome {
  let cur = s;
  for (let i = 0; i < MAX_DECODE_ITERATIONS; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return { converged: true, value: cur };
    }
    if (next === cur) return { converged: true, value: cur };
    cur = next;
  }
  return { converged: false };
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

/** 归一化后的字符串里存在 @，且这个 @ 出现在第一个 / 之前（或者压根没有
    /），一律判"像是把凭据/SSH 用户名拼在地址前面"。牺牲精确度换安全——
    宁可多拦一些其实只是手误打错的字符串，也不能放过真实输入 */
function atSignPrecedesFirstSlash(s: string): boolean {
  const atIdx = s.indexOf("@");
  if (atIdx === -1) return false;
  const slashIdx = s.indexOf("/");
  return slashIdx === -1 || atIdx < slashIdx;
}

/** 解析失败时的保守兜底：依次 trim → 尽力 percent-decode 到不动点（到顶
    未收敛直接判 true，见 bestEffortDecode）→ NFKC 折叠全角/兼容字符
    （必须放在 decode **之后**：这样"先编码再用全角"和"先全角再编码"两种
    混用写法都会在这一步之前被还原成能匹配到的形态）→ 剥 scheme → 剥所有
    前导 / → 在结果里找"第一个 / 之前有没有 @"。每一步单独命名、单独
    可测——round 1 把"剥 scheme"和"找边界"拧在一个函数里，round 2 就在
    同一个函数里又漏了解码和协议相对形式两类；拆开写是为了不再在一个
    函数体内悄悄漏掉下一类形态，新增一类绕过时应该是新增一步或修一步，
    而不是在混在一起的逻辑里再插一个特判 */
function hasAtBeforeFirstSlash(raw: string): boolean {
  const decoded = bestEffortDecode(raw.trim());
  if (!decoded.converged) return true;
  const normalized = stripLeadingSlashes(
    stripSchemePrefix(decoded.value.normalize("NFKC"))
  );
  return atSignPrecedesFirstSlash(normalized);
}

/** URL 的 userinfo（username 和/或 password）非空，就是把凭据拼进了地址里
    （`user:pass@host` 或 `<token>@host` 两种形态，解出来分别是
    username="user"/password="pass" 和 username="<token>"/password=""）。
    能被 WHATWG URL 正常解析出来的情况用 URL() 判——`https://github.com/x/y@z`
    这种"@ 出现在 path 里"的合法地址不该被误伤，URL() 按 authority 边界解析，
    不会把 path 里的 @ 认成 userinfo。解析失败（缺 scheme、scp 语法、端口
    非法、编码过的 @、协议相对形式、全角/小型 @……）不退到"没有凭据"，改用
    hasAtBeforeFirstSlash 的保守兜底——见文件头三轮"复审"记录。**这个函数
    现在是早期 UX 提示，不是安全边界**，见文件头"定位变更" */
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
