import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILE_ICON,
  fileIconName,
} from "../../src/renderer/src/lib/fileIcon.js";
import { BY_EXTENSION, BY_NAME, ICON_NAMES } from "../../src/renderer/src/lib/fileIconMap.js";

describe("fileIconName —— 路径认图标", () => {
  it("按后缀认", () => {
    expect(fileIconName("src/store.ts")).toBe("typescript");
    expect(fileIconName("App.tsx")).toBe("react_ts");
    expect(fileIconName("main.py")).toBe("python");
    expect(fileIconName("a.rs")).toBe("rust");
  });

  it("整个文件名压过后缀 —— package.json 是 node 的东西，不是一个普通 json", () => {
    expect(fileIconName("package.json")).toBe("nodejs");
    expect(fileIconName("tsconfig.json")).toBe("tsconfig");
    expect(fileIconName("a.json")).toBe("json");
  });

  it("长后缀压过短后缀 —— foo.test.ts 是测试，不是普通 ts", () => {
    expect(fileIconName("lib/foo.test.ts")).toBe("test-ts");
    expect(fileIconName("lib/foo.ts")).toBe("typescript");
  });

  it("点号开头的文件:整名匹配优先，没有整名就把点后面那段当后缀", () => {
    expect(fileIconName(".gitignore")).toBe("git");
    // .env 不在整名表里,但它的后缀就是 env —— 上游(VS Code 里)给的正是这枚齿轮。
    // 这条是回归:早先把"点号开头"整个跳过了后缀匹配,.env 掉进通用图标
    expect(fileIconName(".env")).toBe("tune");
    expect(fileIconName(".hidden.ts")).toBe("typescript");
  });

  it("两种路径分隔符都认（工具输出可能来自 Windows 侧）", () => {
    expect(fileIconName("C:\\repo\\src\\main.go")).toBe("go");
    expect(fileIconName("/repo/src/main.go")).toBe("go");
  });

  it("大小写不影响", () => {
    expect(fileIconName("README.md")).toBe("readme");
    expect(fileIconName("Main.PY")).toBe("python");
  });

  it("认不出就退回通用图标，不猜", () => {
    expect(fileIconName("noext")).toBe(DEFAULT_FILE_ICON);
    expect(fileIconName("weird.zzzzz")).toBe(DEFAULT_FILE_ICON);
    expect(fileIconName("")).toBe(DEFAULT_FILE_ICON);
    expect(fileIconName("/")).toBe(DEFAULT_FILE_ICON);
  });

  it("目录路径按最后一段认（结尾的斜杠不算一段）", () => {
    expect(fileIconName("src/lib/")).toBe(DEFAULT_FILE_ICON);
  });
});

describe("生成的对照表自洽", () => {
  // 表里指到一枚没抄进来的图标 = 界面上一个 404 的 <img>。生成脚本已经在筛，
  // 这条是钉住它：以后有人手改了表，这里会红
  it("每一条都指向确实抄进来的图标", () => {
    const shipped = new Set<string>(ICON_NAMES);
    for (const [key, icon] of Object.entries(BY_EXTENSION)) {
      expect(shipped.has(icon), `后缀 ${key} → ${icon}`).toBe(true);
    }
    for (const [key, icon] of Object.entries(BY_NAME)) {
      expect(shipped.has(icon), `文件名 ${key} → ${icon}`).toBe(true);
    }
  });

  it("兜底的那两枚在名单里 —— 认不出时要有东西可画", () => {
    expect(ICON_NAMES).toContain(DEFAULT_FILE_ICON);
    expect(ICON_NAMES).toContain("folder");
  });
});
