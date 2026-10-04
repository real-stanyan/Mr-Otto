// 手机端私聊发图片 / 视频的接线（#1443 P1，ADR-0342）。判据在 src/shared/chatMedia.ts（另有用例）；手机代码依赖
// react-native 进不了 vitest，这里读源码钉住三件安静出错的事：
// ① 读私聊的三条查询都走「带 media、没这一列就退回」那一层——漏一条，0052 没跑时那一条就整个拉不下来；
// ② 上传走签名地址 + 原样 PUT、不覆盖（x-upsert: false）——覆盖的话一个 uuid 撞上就是改掉别人已经看过的图；
// ③ 这一期只能走热更新：手机端用到的原生模块必须已经在 package.json 里（不许为了它加新的）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("friendsApi", () => {
  const src = read("mobile/src/friends/friendsApi.ts");
  it("读私聊的查询都经 selectMessages（0052 没跑时退回不带 media 的列）", () => {
    expect(src.match(/selectMessages\(\(cols\)/g)?.length).toBe(3);
    expect(src).not.toMatch(/select\(MESSAGE_COLUMNS\)/);
  });
  it("媒体那一格过 parseDmMedia（路径必须落在这一对人的目录下）", () => {
    expect(src).toMatch(/parseDmMedia\(m\.media, m\.sender, m\.recipient\)/);
  });
  it("上传：签名地址 + PUT 原样字节 + 不覆盖", () => {
    expect(src).toMatch(/createSignedUploadUrl\(path\)/);
    expect(src).toMatch(/httpMethod: "PUT"/);
    expect(src).toMatch(/UploadType\.BINARY_CONTENT/);
    expect(src).toMatch(/"x-upsert": "false"/);
  });
});

describe("FriendChatScreen", () => {
  const src = read("mobile/src/friends/FriendChatScreen.tsx");
  it("＋ 里有「相册」「拍摄」", () => {
    expect(src).toMatch(/label: "相册", onPress: \(\) => void sendPicked\(pickFromLibrary\)/);
    expect(src).toMatch(/label: "拍摄", onPress: \(\) => void sendPicked\(pickFromCamera\)/);
  });
  it("一次挑的拆成几条走 planMediaMessages；正文藏不藏走 mediaBodyHidden", () => {
    expect(src).toMatch(/planMediaMessages\(ready\)/);
    expect(src).toMatch(/mediaBodyHidden\(m\.body, m\.media \?\? null\)/);
  });
});

describe("只走热更新：用到的原生模块都已经在原生包里", () => {
  const pkg = JSON.parse(read("mobile/package.json")) as { dependencies: Record<string, string> };
  const files = ["mobile/src/media/prepareMedia.ts", "mobile/src/media/MediaViewer.tsx", "mobile/src/media/MediaBubble.tsx", "mobile/src/friends/friendsApi.ts", "mobile/src/friends/friendsStore.ts"];
  it("import 的 expo-* 都在 mobile/package.json 里", () => {
    for (const f of files) {
      for (const m of read(f).matchAll(/from "(expo-[a-z-]+)"/g)) {
        expect(pkg.dependencies, `${f} 用了 ${m[1]}`).toHaveProperty(m[1] ?? "");
      }
    }
  });
});
