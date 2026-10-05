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
    expect(chat).toMatch(/<AppShareBubble card=\{appCard\} mine=\{mine\} messageId=\{m\.id\} room=\{invite\?\.room \?\? null\} \/>/);
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
    expect(src).toMatch(/case "room\.rooms": return \(\(await listRooms\(supabase, familyOf\(l\.app\), familyOf\(l\.app\)\)\) \?\? \[\]\)\.map\(roomSummary\);/);
    expect(src).toMatch(/updatedAt: new Date\(r\.updatedTs\)\.toISOString\(\)/);
    expect(src).toMatch(/case "room\.send": \{\s*needRoom\(l\);/);
  });
  it("room.open 当前这一间是空操作、回 true（不重进、不 replace）", () => {
    expect(src).toMatch(/if \(typeof a0 !== "string"\) throw new Error\("要给房间 id"\);\s*if \(l\.room !== null && a0 === l\.room\.id\) return true;/);
  });
  it("房间模式下标记正在看这间（setOpenKey(\"r:\" + roomId)），同一间的叫人推送不弹横幅；离开时清掉", () => {
    expect(src).toMatch(/import \{ setOpenKey \} from "\.\.\/inbox\/seenStore\.js";/);
    expect(src).toMatch(/setOpenKey\("r:" \+ openRoomId\);\s*return \(\) => \{\s*setOpenKey\(null\);/);
  });
  it("room.open 进一间只是被邀请的房：先 joinRoom 再换页；房间模式读不到那一版给明白话", () => {
    expect(src).toMatch(/if \(mine\?\.status === "invited"\) await joinRoom\(supabase, a0\);\s*navigation\.replace\("MiniApp", \{ appId: l\.app\.id, roomId: a0 \}\);/);
    expect(src).toContain("进不了这一局的那一版（先在私聊里点加入）");
  });
  it("订阅推成 otto 事件；离开页面退订", () => {
    expect(src).toMatch(/const roomId = loaded\.room\.id;\s*const uid = loaded\.uid;/);
    expect(src).toMatch(/link = subscribeRoom\(supabase, roomId, uid, \{/);
    expect(src).toMatch(/bridgeEventJs\("room\.change", e\)/);
    expect(src).toMatch(/bridgeEventJs\("room\.message", \{ from, msg \}\)/);
    expect(src).toMatch(/closing = true;\s*if \(retry !== null\) clearTimeout\(retry\);\s*prevClose\.current = started\.then\(\(\) => link\?\.close\(\)\)/);
  });
  it("回前台 / 频道断了就重订，重订后 resync（全量 room.change + room.members）；自己关的不算断", () => {
    expect(src).toMatch(/AppState\.addEventListener\("change", \(st\) => \{/);
    // 只认真从后台回来（拉通知栏 / 控制中心是 inactive → active，socket 好好的，不掐）
    expect(src).toMatch(/if \(st === "background"\) sawBackground\.current = true;\s*else if \(st === "active" && sawBackground\.current\) \{/);
    // 新订阅排在上一条真拆完、这间房残留频道清掉之后（realtime-js 同名频道还在 leaving 时 subscribe 是空操作）
    expect(src).toMatch(/const started = before\s*\.then\(\(\) => releaseRoomChannels\(supabase, roomId\)\)\s*\.then\(\(\) => \{\s*if \(closing\) return;/);
    // 退避 2s 起翻倍、封顶 30s，连败 6 次放弃；订上了清零
    expect(src).toMatch(/const RELINK_TRIES_MAX = 6;/);
    expect(src).toMatch(/Math\.min\(2000 \* 2 \*\* relinkFails\.current, RELINK_WAIT_MAX_MS\)/);
    expect(src).toMatch(/if \(relinkFails\.current >= RELINK_TRIES_MAX\) return;/);
    expect(src).toMatch(/if \(s === "CHANNEL_ERROR" \|\| s === "TIMED_OUT" \|\| s === "CLOSED"\) again\(\);/);
    expect(src).toMatch(/if \(closing \|\| retry !== null\) return;/);
    expect(src).toMatch(/void roomData\.list\(supabase, roomId, ""\)\.then\(/);
    expect(src).toMatch(/\}, \[loaded\?\.room\?\.id, relink\]\);/);
  });
  it("邀请：先 inviteToRoom 再发邀请信封；卡上是房主那份应用；上一个没回的 invite 先回空", () => {
    expect(src).toMatch(/await inviteToRoom\(supabase, room\.id, (\w+)\);\s*await sendToFriend\(\1, encodeRoomInvite\(/);
    expect(src).toMatch(/appId: room\.hostAppId, version: room\.hostVersion/);
    expect(src).toMatch(/inviteDone\.current\?\.\(\[\]\);\s*inviteDone\.current = resolve;/);
  });
  it("房间模式下分享 / 让管理员修：分享卡用我自己那份的 currentVersion；修的那句标明是房主那一版", () => {
    expect(src).toMatch(/version: loaded\.app\.currentVersion/);
    expect(src).toMatch(/`\$\{loaded\.app\.name\}（房主那一版）`/);
  });
});

describe("邀请卡（#1675）", () => {
  it("私聊页把 room 一格传给应用卡气泡", () => {
    const chat = read("mobile/src/friends/FriendChatScreen.tsx");
    expect(chat).toMatch(/const invite = appCard !== null \? decodeRoomInvite\(m\.body\) : null;/);
    expect(chat).toMatch(/<AppShareBubble card=\{appCard\} mine=\{mine\} messageId=\{m\.id\} room=\{invite\?\.room \?\? null\} \/>/);
  });
  it("加入：先读这间房、按家认我手里那份（myAppForHost 带 familyId）；没有才 appAccept 复制 → refreshApps → joinRoom → 进房间模式", () => {
    const b = read("mobile/src/apps/AppShareBubble.tsx");
    expect(b).toMatch(/const r = await fetchRoom\(supabase, room\.id\);\s*if \(r === null\) throw new Error\("这一局已经没了，或你没被邀请"\);/);
    // 应用清单还没拉到（null）时先现拉一次再认，拉不到就停——不然当成「没有」去 appAccept，会多出一份副本
    expect(b).toMatch(/const list = apps\.apps \?\? \(await fetchApps\(supabase\)\);\s*if \(list === null\) throw new Error\("应用清单这会儿读不出来，稍后再点"\);/);
    expect(b).toMatch(/myAppForHost\(list, r\.hostAppId, r\.familyId\)/);
    const order = ["fetchRoom(supabase, room.id)", "apps.apps ?? (await fetchApps(supabase))", "myAppForHost(", "cloudClient.appAccept(messageId)", "await refreshApps()", "await joinRoom(supabase, room.id)", 'navigation.navigate("MiniApp", { appId: myAppId, roomId: room.id })', /finally \{\s*setBusy\(false\)/];
    const joinSrc = b.slice(b.indexOf("const join = async"));
    const at = order.map((s) => (typeof s === "string" ? joinSrc.indexOf(s) : joinSrc.search(s)));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
  });
  it("room.open 的 listRooms 第二个 id 也给我的源（familyOf）：开在我被复制自的那份上的房也认", () => {
    expect(read("mobile/src/apps/MiniAppScreen.tsx")).toMatch(/const rooms = \(await listRooms\(supabase, familyOf\(l\.app\), familyOf\(l\.app\)\)\) \?\? \[\];/);
  });
});

describe("房间推送点开（#1675）", () => {
  it("room 目标：找我名下对应房主应用的那一份，进 MiniApp 房间模式；找不到回首页", () => {
    const src = read("mobile/src/push/messagePush.ts");
    expect(src).toMatch(/if \(t\.kind === "room"\) \{/);
    expect(src).toMatch(/const \[apps, room\] = await Promise\.all\(\[fetchApps\(supabase\), fetchRoom\(supabase, t\.roomId\)\]\);/);
    expect(src).toMatch(/myAppForHost\(apps \?\? \[\], room\?\.hostAppId \?\? t\.hostAppId, room\?\.familyId\)/);
    expect(src).toMatch(/\{ name: "MiniApp" as const, params: \{ appId: mine\.id, roomId: t\.roomId \} \}/);
  });
});
