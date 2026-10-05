// Otto 应用手机那半（#1591 第 1 期 b）的接线：判据在 shared 真跑（appBridge.test），这里读源码钉住。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("MiniAppScreen：WebView 宿主 + 桥", () => {
  const src = read("mobile/src/apps/MiniAppScreen.tsx");
  it("文件落本机后以 file:// 载入；只许读这一版的目录；不是本目录的跳转不放行；桥注在内容之前", () => {
    expect(src).toMatch(/const dir = room === null\s*\? await ensureAppFiles\(uid, app\.id, version\.version, version\.files\)/);
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
    expect(read("mobile/src/nav/types.ts")).toMatch(/MiniApp: \{ appId: string; share\?: boolean; roomId\?: string \};/);
    expect(read("mobile/src/nav/RootNavigator.tsx")).toMatch(/<Root\.Screen name="MiniApp" component=\{MiniAppScreen\}/);
  });
  it("app_card 投影成一张 app 行；Bubbles 画 AppCard、点开进 MiniApp", () => {
    expect(read("src/shared/mobileChat.ts")).toMatch(/if \(e\.type === "app_card"\) \{\s*items\.push\(\{ kind: "app", key: `app-\$\{e\.seq\}`/);
    const bubbles = read("mobile/src/chat/Bubbles.tsx");
    expect(bubbles).toMatch(/case "app":\s*return <AppCard row=\{row\} \/>;/);
    expect(bubbles).toMatch(/navigation\.navigate\("MiniApp", \{ appId: row\.appId \}\)/);
  });
});

describe("分享应用给好友（#1648）", () => {
  it("应用页顶上「分享」→ 挑好友 → 私信里一张应用卡；私信里认出应用卡画 AppShareBubble，添加走 app_accept", () => {
    const mini = read("mobile/src/apps/MiniAppScreen.tsx");
    expect(mini).toMatch(/<HeaderTextButton label="分享"/);
    expect(mini).toMatch(/for \(const p of people\) await sendToFriend\(p, body\);/);
    const chat = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(chat).toMatch(/<AppShareBubble card=\{appCard\} mine=\{mine\} messageId=\{m\.id\} \/>/);
    expect(read("mobile/src/apps/AppShareBubble.tsx")).toMatch(/cloudClient\.appAccept\(messageId\)/);
  });

  it("应用卡整张可点：发的人点开自己那份，收的人加过打开、没加过走添加（#1657）", () => {
    const bubble = read("mobile/src/apps/AppShareBubble.tsx");
    expect(bubble).toMatch(/if \(mine\) navigation\.navigate\("MiniApp", \{ appId: card\.appId \}\);/);
    expect(bubble).toMatch(/else if \(added !== null\) navigation\.navigate\("MiniApp", \{ appId: added\.id \}\);/);
    expect(bubble).toMatch(/onPress=\{open\}/);
  });
});

describe("主页下拉出应用抽屉（#1648）", () => {
  it("列表顶到头往下拽过线松手就开；点一个进 MiniApp；打开应用记一次最近使用", () => {
    const chats = read("mobile/src/tabs/ChatsScreen.tsx");
    expect(chats).toMatch(/onScrollEndDrag=\{\(e\) => \{ if \(e\.nativeEvent\.contentOffset\.y <= -APPS_PULL_TRIGGER && !searching\) setAppsOpen\(true\); \}\}/);
    expect(chats).toMatch(/onPick=\{\(appId, opts\) => navigation\.navigate\("MiniApp", \{ appId, \.\.\.\(opts\?\.share === true \? \{ share: true \} : \{\}\) \}\)\}/);
    expect(read("mobile/src/apps/MiniAppScreen.tsx")).toMatch(/markAppOpened\(app\.id\);/);
    const drawer = read("mobile/src/apps/AppsDrawer.tsx");
    expect(drawer).toContain("最近使用");
    expect(drawer).toContain("我的应用");
    expect(drawer).toContain("搜索应用");
  });
});

describe("私聊 ＋ 里发应用；抽屉长按分享 / 删除（#1648 真机）", () => {
  it("＋ 里多一格「应用」→ AppPickSheet → sendToFriend；抽屉长按弹分享 / 删除，删走 app_delete", () => {
    const chat = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(chat).toMatch(/\{ key: "app", icon: "app-window", label: "应用"/);
    expect(chat).toMatch(/onSend=\{\(body\) => sendToFriend\(uid, body\)\}/);
    const drawer = read("mobile/src/apps/AppsDrawer.tsx");
    expect(drawer).toMatch(/onLongPress=\{\(\) => more\(a\)\}/);
    expect(drawer).toMatch(/cloudClient\.appDelete\(a\.id\)/);
    expect(drawer).toContain("分享给朋友");
  });
});

describe("房间模式（#1675）", () => {
  const src = read("mobile/src/apps/MiniAppScreen.tsx");
  it("路由多 roomId；有 roomId 时跑房主钉住的那一版", () => {
    expect(read("mobile/src/nav/types.ts")).toMatch(/MiniApp: \{ appId: string; share\?: boolean; roomId\?: string \};/);
    expect(src).toMatch(/const room = roomId === undefined \? null : await fetchRoom\(supabase, roomId\);/);
    expect(src).toMatch(/fetchAppVersion\(supabase, room\.hostAppId, room\.hostVersion\)/);
    expect(src).toMatch(/ensureAppFiles\(room\.hostUid, room\.hostAppId, room\.hostVersion, version\.files\)/);
  });
  it("个人 storage 仍落在我自己那份应用；room.* 走 appRoomApi；不在房间的数据操作拒", () => {
    expect(src).toMatch(/case "storage\.get": return appData\.get\(supabase, l\.app\.id, l\.uid, a0\);/);
    expect(src).toMatch(/case "room\.set": return roomData\.set\(supabase, needRoom\(l\)\.id, a0, a1, req\.args\[2\]\);/);
    expect(src).toMatch(/case "room\.ping": return pingRoom\(supabase, needRoom\(l\)\.id, a0\);/);
    expect(src).toMatch(/case "room\.rooms": return \(await listRooms\(supabase, familyOf\(l\.app\)\)\) \?\? \[\];/);
  });
  it("订阅推成 otto 事件；离开页面退订", () => {
    expect(src).toMatch(/subscribeRoom\(supabase, loaded\.room\.id, loaded\.uid, \{/);
    expect(src).toMatch(/bridgeEventJs\("room\.change", e\)/);
    expect(src).toMatch(/bridgeEventJs\("room\.message", \{ from, msg \}\)/);
    expect(src).toMatch(/return \(\) => link\.close\(\);/);
  });
  it("邀请：先 inviteToRoom 再发邀请信封", () => {
    expect(src).toMatch(/await inviteToRoom\(supabase, room\.id, p\.uid\);\s*await sendToFriend\(p\.uid, encodeRoomInvite\(/);
  });
});
