// identity — "显示谁的名字/头像"的裁决,以及首登引导什么时候弹。
// 这两条规则散在四五个渲染点上过一次就会走样,所以它们只有这一份实现。

import { describe, expect, it } from "vitest";
import { displayIdentity, needsOnboarding, needsSignIn } from "../../src/renderer/src/lib/identity.js";
import type { AccountInfo } from "../../src/shared/shellBridge.js";
import type { MyProfile } from "../../src/shared/profile.js";

const account: AccountInfo = {
  signedIn: true, email: "a@b.c", name: "Provider 名", avatarUrl: "https://p/a.png",
};
const OUT: AccountInfo = { signedIn: false, email: "", name: "", avatarUrl: "" };

function profile(over: Partial<MyProfile> = {}): MyProfile {
  return { id: "u1", email: "a@b.c", name: "", avatarUrl: "", onboarded: false, ...over };
}

describe("displayIdentity", () => {
  it("没有 profile 时退回 account —— 冷启动那半秒不该是空白", () => {
    expect(displayIdentity(account, null)).toEqual({
      name: "Provider 名", email: "a@b.c", avatarUrl: "https://p/a.png", initial: "P",
    });
  });

  it("profile 有值时压过 account:好友看到的是 profiles,自己也得看到同一个", () => {
    const id = displayIdentity(account, profile({ name: "我改的名", avatarUrl: "data:image/webp;base64,A" }));
    expect(id.name).toBe("我改的名");
    expect(id.avatarUrl).toBe("data:image/webp;base64,A");
  });

  it("profile 的空串不算'有值' —— 没设过头像的行是 '' 而不是 null,不能拿它盖掉 provider 的图", () => {
    const id = displayIdentity(account, profile({ name: "", avatarUrl: "" }));
    expect(id.name).toBe("Provider 名");
    expect(id.avatarUrl).toBe("https://p/a.png");
  });

  it("只有空格的名字同样退回 account", () => {
    expect(displayIdentity(account, profile({ name: "   " })).name).toBe("Provider 名");
  });

  it("首字母取码点:emoji 名字不该被切成半个代理对", () => {
    expect(displayIdentity(account, profile({ name: "🦦 阿獭" })).initial).toBe("🦦");
  });

  it("彻底没名字时首字母是 ?", () => {
    expect(displayIdentity(OUT, null).initial).toBe("?");
  });
});

describe("needsOnboarding", () => {
  it("登录 + 资料已读到 + 没盖章 → 弹", () => {
    expect(needsOnboarding(account, profile({ onboarded: false }))).toBe(true);
  });

  it("盖过章就不再弹(换机器/重装也不会回来,标记在库里)", () => {
    expect(needsOnboarding(account, profile({ onboarded: true }))).toBe(false);
  });

  it("资料还没读到时不弹 —— 否则每次登录都会先闪半秒引导", () => {
    expect(needsOnboarding(account, null)).toBe(false);
  });

  it("没登录不弹", () => {
    expect(needsOnboarding(OUT, profile())).toBe(false);
  });

  it("测试账号无视盖章,每次登录都弹(issue #332)", () => {
    const tester: AccountInfo = { ...account, email: "stan@herzpharmaceuticals.com" };
    expect(needsOnboarding(tester, profile({ onboarded: true }))).toBe(true);
    // 防闪那条对测试账号同样成立:资料没读到就先不弹
    expect(needsOnboarding(tester, null)).toBe(false);
  });
});

describe("needsSignIn（进门闸，ADR-0181）", () => {
  it("从没登录过 = 拦在门外", () => {
    expect(needsSignIn(OUT, false)).toBe(true);
  });

  it("有登录记录就放行，哪怕此刻 signedIn 还是假——这一条是冷启动不闪登录页的全部理由", () => {
    // 冷启动的真实形状：主进程的 restore() 是 fire-and-forget 且要等一次网络往返，
    // getAccount() 先回来的几乎必然是这个空账号。照 signedIn 判定的话，
    // 已登录用户每次开 app 都会先看到一屏登录页再被顶掉
    expect(needsSignIn(OUT, true)).toBe(false);
  });

  it("断网同理：restore() 永远回不来，但本地记录还在，人不该被锁在自己的软件外面", () => {
    expect(needsSignIn(OUT, true)).toBe(false);
  });

  it("登录着 = 放行（记录标志迟到也不该把人弹出去）", () => {
    expect(needsSignIn(account, false)).toBe(false);
    expect(needsSignIn(account, true)).toBe(false);
  });
});
