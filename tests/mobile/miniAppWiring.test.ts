// Otto 应用手机那半（#1591 第 1 期 b）的接线：判据在 shared 真跑（appBridge.test），这里读源码钉住。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("MiniAppScreen：WebView 宿主 + 桥", () => {
  const src = read("mobile/src/apps/MiniAppScreen.tsx");
  it("文件落本机后以 file:// 载入；只许读这一版的目录；不是本目录的跳转不放行；桥注在内容之前", () => {
    expect(src).toMatch(/const dir = await ensureAppFiles\(uid, app\.id, version\.version, version\.files\);/);
    expect(src).toMatch(/source=\{\{ uri: appFileUri\(loaded\.dirUri, page\) \}\}/);
    expect(src).toMatch(/allowingReadAccessToURL=\{loaded\.dirUri\}/);
    expect(src).toMatch(/onShouldStartLoadWithRequest=\{\(r\) => r\.url\.startsWith\(loaded\.dirUri\)\}/);
    expect(src).toMatch(/injectedJavaScriptBeforeContentLoaded=\{APP_BRIDGE_JS\}/);
  });
  it("桥：先按清单的能力拦（bridgeDenied）；storage 走 app_data；ask 把人带到管理员私聊并经 dispatch 发出；nav 只认文件表里的页", () => {
    expect(src).toMatch(/const denied = bridgeDenied\(req\.method, l\.version\.manifest\.capabilities\);/);
    expect(src).toMatch(/case "storage\.get": return appData\.get\(supabase, l\.app\.id, l\.uid, a0\);/);
    expect(src).toMatch(/navigation\.navigate\("Chat", \{ kind: "agent", agentId: ADMIN_AGENT_ID, dispatch: line \}\);/);
    expect(src).toMatch(/if \(!appPageOk\(l\.version\.files, a0\)\) throw new Error\("没有这一页"\);/);
  });
});

describe("应用页与聊天里的卡", () => {
  it("应用页最上段「我的应用」，点开进 MiniApp；路由与导航都挂上", () => {
    const apps = read("mobile/src/machine/AppsScreen.tsx");
    expect(apps).toMatch(/<Group header="我的应用"/);
    expect(apps).toMatch(/navigation\.navigate\("MiniApp", \{ appId: a\.id \}\)/);
    expect(read("mobile/src/nav/types.ts")).toMatch(/MiniApp: \{ appId: string \};/);
    expect(read("mobile/src/nav/RootNavigator.tsx")).toMatch(/<Root\.Screen name="MiniApp" component=\{MiniAppScreen\}/);
  });
  it("app_card 投影成一张 app 行；Bubbles 画 AppCard、点开进 MiniApp", () => {
    expect(read("src/shared/mobileChat.ts")).toMatch(/if \(e\.type === "app_card"\) \{\s*items\.push\(\{ kind: "app", key: `app-\$\{e\.seq\}`/);
    const bubbles = read("mobile/src/chat/Bubbles.tsx");
    expect(bubbles).toMatch(/case "app":\s*return <AppCard row=\{row\} \/>;/);
    expect(bubbles).toMatch(/navigation\.navigate\("MiniApp", \{ appId: row\.appId \}\)/);
  });
});

describe("主页下拉出应用抽屉（#1648）", () => {
  it("列表顶到头往下拽过线松手就开；点一个进 MiniApp；打开应用记一次最近使用", () => {
    const chats = read("mobile/src/tabs/ChatsScreen.tsx");
    expect(chats).toMatch(/onScrollEndDrag=\{\(e\) => \{ if \(e\.nativeEvent\.contentOffset\.y <= -APPS_PULL_TRIGGER && !searching\) setAppsOpen\(true\); \}\}/);
    expect(chats).toMatch(/onPick=\{\(appId\) => navigation\.navigate\("MiniApp", \{ appId \}\)\}/);
    expect(read("mobile/src/apps/MiniAppScreen.tsx")).toMatch(/markAppOpened\(app\.id\);/);
    const drawer = read("mobile/src/apps/AppsDrawer.tsx");
    expect(drawer).toContain("最近使用");
    expect(drawer).toContain("我的应用");
    expect(drawer).toContain("搜索应用");
  });
});
