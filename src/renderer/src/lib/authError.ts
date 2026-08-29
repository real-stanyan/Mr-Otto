// authError — 登录/注册报错 → 一句人话 + 一步能做的事。
//
// 起因是一条真实的截图：注册时邮箱少写了 `.com`，界面上原样吐出
//   Error invoking remote method 'otter:signUpWithPassword': Error: Email address "1464729020@qq" is invalid
// 三层噪音叠在一起：Electron 的 IPC 外壳、supabase 的英文原文、还有"remote method"
// 这种只有实现者看得懂的词。用户要的信息其实只有一句「邮箱写全了吗」。
//
// 与 `bridgeError.ts` 的分工：那边剥的是**所有** IPC 调用共有的那层壳（通道名、
// `Error: ` 前缀、主进程版本错配），是通用的；这边翻的是**登录这件事**特有的
// 那批 supabase GoTrue 报文。所以这里先调它、再往下认。
//
// 认不出来的照样显示原文（`raw`）——只是降级成小字。全翻成「出错了」会让
// 用户没法求助、我们也没法排查，那是把问题藏起来而不是解决它。

import { bridgeErrorMessage } from "./bridgeError.js";

export interface AuthNotice {
  /** 发生了什么。一句话，不带术语 */
  title: string;
  /** 下一步做什么。没有可做的就不给 */
  hint?: string;
  /** 没认出来的原文。只有兜底那条才有 —— 留着是为了还能排查 */
  raw?: string;
}

/** 有序表：先匹配先用。写成数组而不是 map，因为「先后」本身是语义
    （`Email address ... invalid` 要排在泛化的 `invalid` 前面） */
const RULES: { re: RegExp; of: (m: RegExpMatchArray) => AuthNotice }[] = [
  {
    // supabase 对 `user@qq` 这种没有顶级域名的地址就报这一句。
    // HTML 的 type="email" **不会**拦住它（规范允许无点域名），所以这条一定会被撞到
    re: /Email address .* is invalid|invalid.*email|email.*invalid_format/i,
    of: () => ({ title: "这个邮箱地址填得不太对", hint: "检查一下有没有写全，比如 @qq.com 而不是 @qq" }),
  },
  {
    re: /already registered|already been registered|user_already_exists/i,
    of: () => ({ title: "这个邮箱已经注册过了", hint: "直接用它登录就行；不记得密码的话换一个邮箱注册" }),
  },
  {
    re: /Invalid login credentials|invalid_credentials/i,
    of: () => ({ title: "邮箱或密码不对", hint: "再试一次，注意密码的大小写" }),
  },
  {
    re: /Email not confirmed|email_not_confirmed/i,
    of: () => ({ title: "还差点一下确认邮件", hint: "去邮箱找 Mr Otto 那封信，点开里面的链接，再回来登录" }),
  },
  {
    re: /Password should be at least (\d+)/i,
    of: (m) => ({ title: "密码太短了", hint: `至少要 ${m[1]} 位` }),
  },
  {
    re: /Password.*weak|weak_password/i,
    of: () => ({ title: "这个密码太好猜了", hint: "换一个长一点、别只有数字的" }),
  },
  {
    // GoTrue 的防刷：`For security purposes, you can only request this after 47 seconds.`
    re: /you can only request this after (\d+) second/i,
    of: (m) => ({ title: "点得太快了", hint: `等 ${m[1]} 秒再试一次` }),
  },
  // ── 以下两条是「我们这边的毛病」，一律说成**服务器忙** ────────────────
  // 用户不该看见我们的运维细节（发信配额、SMTP、数据库），那些词对他零信息量，
  // 还会让他误以为是自己哪里做错了。他需要的只有两件事：不是你的错、接下来做什么。
  {
    // 发信配额到顶。实测（2026-08-29）本项目 `rate_limit_email_sent = 2`、
    // `smtp_host = None` —— Supabase 内置邮件通道全项目每小时 2 封（issue #738）。
    // 单列在泛化限流**之前**：这条和"这个人点太快"是两回事，配额很可能是别人用掉的
    re: /over_email_send_rate_limit|email rate limit/i,
    of: () => ({
      title: "服务器有点忙",
      hint: "验证邮件暂时发不出去，过一会儿再试；急的话可以直接用 Google 或 GitHub 登录",
    }),
  },
  {
    // 服务端自己出错的那一批。原来它们会掉进最后那条兜底，于是用户看到一句
    // "登录没成功" + 一行英文原文 —— 把我们的故障原样摊在他面前
    re: /unexpected_failure|Internal Server Error|Service Unavailable|Bad Gateway|Database error/i,
    of: () => ({ title: "服务器有点忙", hint: "过一会儿再试" }),
  },
  {
    // 这一条才是真的"你点太快了"：请求频率限流，等一会儿就好
    re: /rate limit|too many requests|over_request_rate_limit/i,
    of: () => ({ title: "试得太频繁了", hint: "歇几分钟再来" }),
  },
  {
    re: /Signups not allowed|signup_disabled/i,
    of: () => ({ title: "现在暂时不开放注册", hint: "过阵子再试，或者用 Google / GitHub 登录" }),
  },
  {
    // 断网/DNS/超时都归这一类：用户能做的事是同一件
    re: /fetch failed|Failed to fetch|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|network|socket hang up/i,
    of: () => ({ title: "连不上服务器", hint: "看一眼网络，或者过一会儿再试" }),
  },
];

/**
 * 报错 → 给人看的那张卡的内容。
 *
 * 入参给什么都行：Error、字符串、store.error 里那份已经被 `bridgeErrorMessage`
 * 剥过壳的文本。剥壳是幂等的，重复调一次无害。
 */
export function authNotice(e: unknown): AuthNotice {
  const message = bridgeErrorMessage(e).trim();
  if (message === "") return { title: "没成功，但没说原因", hint: "再试一次；一直这样的话重启一下 Mr Otto" };

  for (const { re, of } of RULES) {
    const m = message.match(re);
    if (m) return of(m);
  }

  // `bridgeErrorMessage` 认出来的那几条本来就是中文人话（比如主进程版本错配），
  // 不该再被套一层"没成功"。判据取"有没有中日韩字符"——它翻译过的都是中文
  if (/[一-鿿]/.test(message)) return { title: message };

  return { title: "登录没成功", hint: "再试一次；反复失败的话把下面这行发给我们", raw: message };
}

/**
 * 提交前先在本地判一次邮箱形状，**报文和 supabase 那句一模一样**。
 *
 * 为什么要有这一道：`<input type="email">` 的原生校验有两个毛病，都在真机上撞到过。
 *   - `a@` 这种 @ 后面空着的，Chromium 自己弹一个灰色气泡
 *     （"Please enter a part following '@'."）—— 英文、它自己画的、**表单压根不提交**，
 *     于是我们整套报错话术一个字都轮不到（issue #736 的现场截图就是它）。
 *   - `a@qq` 这种没有顶级域名的，规范认为**合法**，原生校验放行，一路打到 supabase
 *     才被拒。等于为了一个一眼可见的笔误跑了一趟网络。
 * 所以表单挂 `noValidate` 关掉原生那套，改由这里判：两种情况归一，都走同一张卡。
 *
 * 判据故意宽松（有 @、@ 两边非空、域名里有点、没有空格）—— 邮箱地址的真实语法
 * 复杂到不值得在客户端复刻，这里只拦"一眼就知道打错了"的那批，剩下的交给服务端。
 * 回 null = 看不出毛病，放它去发请求。
 */
export function localEmailProblem(email: string): string | null {
  const at = email.indexOf("@");
  const domain = at < 0 ? "" : email.slice(at + 1);
  const ok =
    at > 0 &&
    email.indexOf("@", at + 1) < 0 &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".") &&
    !/\s/.test(email);
  // 抄 supabase 的原文而不是自己造一句:这条本地预检是同一个判断的快路径,
  // 两边说同一句话,翻译规则就只需要一条(上面 RULES 的第一条)
  return ok ? null : `Email address "${email}" is invalid`;
}
