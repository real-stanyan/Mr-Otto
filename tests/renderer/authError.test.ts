// authError — 登录报错翻译成人话。
//
// 这些用例里的原文都是真的：第一条就是维护者截图里那句（邮箱少写了 .com），
// 三层噪音叠在一起 —— Electron 的 IPC 外壳、supabase 的英文、"remote method"。

import { describe, expect, it } from "vitest";
import { authNotice, localEmailProblem } from "../../src/renderer/src/lib/authError.js";

describe("authNotice", () => {
  it("邮箱没写全：连 IPC 外壳一起剥掉，只留一句人话 + 一步能做的事", () => {
    const raw =
      `Error invoking remote method 'otter:signUpWithPassword': Error: Email address "1464729020@qq" is invalid`;
    const n = authNotice(new Error(raw));
    expect(n.title).toBe("这个邮箱地址填得不太对");
    expect(n.hint).toContain("@qq.com");
    // 认出来了就不留原文——留着等于没翻译
    expect(n.raw).toBeUndefined();
  });

  it("邮箱已注册：告诉他改去登录，而不是复述 already registered", () => {
    const n = authNotice(new Error("User already registered"));
    expect(n.title).toBe("这个邮箱已经注册过了");
    expect(n.hint).toContain("登录");
  });

  it("密码错", () => {
    expect(authNotice(new Error("Invalid login credentials")).title).toBe("邮箱或密码不对");
  });

  it("还没点确认邮件", () => {
    const n = authNotice(new Error("Email not confirmed"));
    expect(n.title).toContain("确认邮件");
    expect(n.hint).toContain("链接");
  });

  it("密码太短：位数从原文里抠出来，不写死 6", () => {
    const n = authNotice(new Error("Password should be at least 8 characters"));
    expect(n.title).toBe("密码太短了");
    expect(n.hint).toBe("至少要 8 位");
  });

  it("防刷：秒数照抄，让人知道要等多久", () => {
    const n = authNotice(new Error("For security purposes, you can only request this after 47 seconds."));
    expect(n.title).toBe("点得太快了");
    expect(n.hint).toBe("等 47 秒再试一次");
  });

  it("断网/DNS/超时归一类——用户能做的事是同一件", () => {
    for (const raw of ["fetch failed", "getaddrinfo ENOTFOUND kpee.supabase.co", "connect ETIMEDOUT"]) {
      expect(authNotice(new Error(raw)).title, raw).toBe("连不上服务器");
    }
  });

  // 我们这边的毛病一律说成「服务器有点忙」：用户不该看见发信配额/SMTP/数据库
  // 这些词，它们对他零信息量，还会让他以为是自己哪儿做错了
  it("发信配额到顶：说成服务器忙，并给一条真的出得去的路", () => {
    const n = authNotice(new Error("email rate limit exceeded"));
    expect(n.title).toBe("服务器有点忙");
    expect(n.hint).toContain("Google");
    for (const leak of ["配额", "邮件通道", "SMTP", "rate limit"]) {
      expect(n.hint, `不该把「${leak}」摊给用户`).not.toContain(leak);
    }
  });

  it("服务端自己出错的那一批也归「服务器有点忙」，不再掉进兜底露出英文原文", () => {
    for (const raw of ["unexpected_failure", "Internal Server Error", "Database error saving new user"]) {
      const n = authNotice(new Error(raw));
      expect(n.title, raw).toBe("服务器有点忙");
      expect(n.raw, raw).toBeUndefined();
    }
  });

  it("请求太频繁是另一回事：这条才是「歇几分钟」", () => {
    const n = authNotice(new Error("over_request_rate_limit"));
    expect(n.title).toBe("试得太频繁了");
  });

  it("认不出来的：给一句人话，但**原文照留**——翻不动的不能凭空吞掉", () => {
    const n = authNotice(new Error("Some brand new GoTrue error nobody has seen"));
    expect(n.title).toBe("登录没成功");
    expect(n.raw).toBe("Some brand new GoTrue error nobody has seen");
  });

  it("bridgeError 已经翻成中文的那几条原样透传，不再套一层「没成功」", () => {
    const raw = `Error invoking remote method 'otter:signIn': Error: No handler registered for 'otter:signIn'`;
    const n = authNotice(new Error(raw));
    expect(n.title).toContain("主进程还是旧的一版");
    expect(n.raw).toBeUndefined();
  });

  it("空的也不能空着——「什么都没说」本身要说出来", () => {
    expect(authNotice(new Error("")).title).not.toBe("");
    expect(authNotice(null).title).not.toBe("");
  });
});

describe("localEmailProblem（提交前的本地预检）", () => {
  it("正常地址放行", () => {
    for (const ok of ["1464729020@qq.com", "a.b+c@sub.example.co.uk", "x@y.zz"]) {
      expect(localEmailProblem(ok), ok).toBeNull();
    }
  });

  it("@ 后面空着 —— 这一类原来被 Chromium 自己拦下、弹英文气泡（#736 现场）", () => {
    expect(localEmailProblem("12312w12412314@")).not.toBeNull();
  });

  it("没有顶级域名 —— 这一类原生校验反而放行，会白跑一趟网络", () => {
    expect(localEmailProblem("1464729020@qq")).not.toBeNull();
  });

  it("其余一眼的笔误：没 @ / @ 前空 / 两个 @ / 带空格 / 域名点在边上", () => {
    for (const bad of ["nope", "@qq.com", "a@b@c.com", "a b@qq.com", "a@.com", "a@qq."]) {
      expect(localEmailProblem(bad), bad).not.toBeNull();
    }
  });

  it("报文与 supabase 那句一致，所以能被 authNotice 翻成同一张卡", () => {
    const bad = localEmailProblem("a@qq");
    expect(bad).toBe('Email address "a@qq" is invalid');
    expect(authNotice(bad).title).toBe("这个邮箱地址填得不太对");
  });
});
