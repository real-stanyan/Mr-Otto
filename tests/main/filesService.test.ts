// filesService 的合同 —— 重点是三条安全边界(越狱路径、大文件、二进制)
// 和 rg 缺失时的降级。全部喂假 deps,不碰真文件系统。

import { describe, expect, it, vi } from "vitest";
import { createFilesService, type FilesDeps } from "../../src/main/filesService.js";

const ROOT = "/w";

function deps(over: Partial<FilesDeps> = {}): FilesDeps {
  return {
    listDir: () => [
      { name: "src", isDir: true, size: 0, mtime: 1 },
      { name: "a.ts", isDir: false, size: 10, mtime: 2 },
    ],
    statSize: () => 10,
    readHead: () => new TextEncoder().encode("hello"),
    realpath: (p) => p,
    execRg: async () => ({ stdout: "" }),
    openPath: () => {},
    showInFolder: () => {},
    exists: (abs) => abs === "/Applications/Visual Studio Code.app",
    homeDir: () => "/Users/me",
    openWith: () => {},
    appIcon: async () => "data:image/png;base64,ICON",
    ...over,
  };
}

describe("list", () => {
  it("列一层,目录在前", () => {
    const svc = createFilesService(deps());
    const r = svc.list(ROOT, "");
    expect(r.ok && r.value.map((e) => e.name)).toEqual(["src", "a.ts"]);
  });

  it("目录读不了 = no-dir,不抛", () => {
    const svc = createFilesService(deps({
      listDir: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    }));
    const r = svc.list(ROOT, "gone");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.kind).toBe("no-dir");
  });

  it("没权限 = denied", () => {
    const svc = createFilesService(deps({
      listDir: () => { throw Object.assign(new Error("nope"), { code: "EACCES" }); },
    }));
    const r = svc.list(ROOT, "secret");
    expect(!r.ok && r.kind).toBe("denied");
  });

  it("../ 越狱挡在读之前", () => {
    const listDir = vi.fn();
    const svc = createFilesService(deps({ listDir }));
    const r = svc.list(ROOT, "../etc");
    expect(!r.ok && r.kind).toBe("outside-root");
    expect(listDir).not.toHaveBeenCalled();
  });
});

describe("read", () => {
  it("普通文本文件读出来", () => {
    const svc = createFilesService(deps());
    const r = svc.read(ROOT, "a.ts");
    expect(r.ok && r.value).toEqual({ text: "hello", truncated: false });
  });

  it("根自己是软链时不算越狱——macOS 的 /var/folders 就是 /private/var 的软链,\n     拿字面根去比会把整个工作区判成越狱(e2e 在这翻过车)", () => {
    const svc = createFilesService(deps({
      realpath: (p) => p.replace(/^\/w/, "/private/w"),
    }));
    const r = svc.read(ROOT, "a.ts");
    expect(r.ok).toBe(true);
  });

  it("符号链接指向根外 = outside-root(realpath 之后才判)", () => {
    const svc = createFilesService(deps({
      realpath: (p) => (p === ROOT ? ROOT : "/etc/passwd"),
    }));
    const r = svc.read(ROOT, "link.txt");
    expect(!r.ok && r.kind).toBe("outside-root");
  });

  it("超过 512KB 只读前 512KB 并标 truncated", () => {
    const big = 600 * 1024;
    const readHead = vi.fn(() => new TextEncoder().encode("head"));
    const svc = createFilesService(deps({ statSize: () => big, readHead }));
    const r = svc.read(ROOT, "big.log");
    expect(r.ok && r.value.truncated).toBe(true);
    expect(readHead).toHaveBeenCalledWith("/w/big.log", 512 * 1024);
  });

  it("二进制不预览 = binary,detail 带大小", () => {
    const svc = createFilesService(deps({
      readHead: () => new Uint8Array([0x89, 0x50, 0x00, 0x01]),
      statSize: () => 2048,
    }));
    const r = svc.read(ROOT, "logo.png");
    expect(!r.ok && r.kind).toBe("binary");
    expect(!r.ok && r.detail).toContain("2048");
  });
});

describe("search", () => {
  it("名字模式:rg --files 的路径表在主进程侧 fuzzy 筛", async () => {
    const execRg = vi.fn(async (_args: string[], _cwd: string) => ({ stdout: "src/fileIcon.ts\nsrc/store.ts\n" }));
    const svc = createFilesService(deps({ execRg }));
    const r = await svc.search(ROOT, "fic", { content: false });
    expect(r.ok && r.value.map((h) => h.rel)).toEqual(["src/fileIcon.ts"]);
    expect(execRg.mock.calls[0]![0]).toContain("--files");
  });

  it("恒含被忽略/隐藏的文件——树全显,搜索另设规矩会变成\"树里看得见、搜不出来\"", async () => {
    const execRg = vi.fn(async (_args: string[], _cwd: string) => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    await svc.search(ROOT, "x", { content: false });
    expect(execRg.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--no-ignore", "--hidden"]));
    await svc.search(ROOT, "x", { content: true });
    expect(execRg.mock.calls[1]![0]).toEqual(expect.arrayContaining(["--no-ignore", "--hidden"]));
  });

  it("内容模式:query 走 -- 之后,不会被当成 rg 的选项", async () => {
    const execRg = vi.fn(async (_args: string[], _cwd: string) => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    await svc.search(ROOT, "-foo", { content: true });
    const args = execRg.mock.calls[0]![0];
    expect(args[args.indexOf("--") + 1]).toBe("-foo");
  });

  it("退出码 1(没匹配)= 空结果,不是错误", async () => {
    const svc = createFilesService(deps({
      execRg: async () => { throw Object.assign(new Error("no match"), { code: 1 }); },
    }));
    const r = await svc.search(ROOT, "zzz", { content: true });
    expect(r.ok && r.value).toEqual([]);
  });

  it("没装 rg = rg-missing,渲染层据此标降级", async () => {
    const svc = createFilesService(deps({
      execRg: async () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); },
    }));
    const r = await svc.search(ROOT, "x", { content: true });
    expect(!r.ok && r.kind).toBe("rg-missing");
  });

  it("空查询不起子进程", async () => {
    const execRg = vi.fn(async (_args: string[], _cwd: string) => ({ stdout: "" }));
    const svc = createFilesService(deps({ execRg }));
    const r = await svc.search(ROOT, "", { content: false });
    expect(r.ok && r.value).toEqual([]);
    expect(execRg).not.toHaveBeenCalled();
  });
});

describe("editors", () => {
  it("只列探到的那几个,顺序照名单", async () => {
    const svc = createFilesService(deps({
      exists: (abs) => abs.endsWith("/Visual Studio Code.app") || abs.endsWith("/Zed.app"),
    }));
    expect((await svc.editors()).map((e) => e.name)).toEqual(["Visual Studio Code", "Zed"]);
  });

  it("两层都装了只算一条——菜单里出现两条同名项没有意义", async () => {
    const svc = createFilesService(deps({ exists: () => true }));
    const names = (await svc.editors()).map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("一个都没装 = 空数组,不是错误(菜单只剩「系统默认」)", async () => {
    const svc = createFilesService(deps({ exists: () => false }));
    expect(await svc.editors()).toEqual([]);
  });

  it("每条带自己那枚图标(data URI)", async () => {
    const svc = createFilesService(deps({
      exists: (abs) => abs.endsWith("/Zed.app"),
      appIcon: async (p) => `icon-of:${p}`,
    }));
    expect((await svc.editors())[0]!.icon).toBe("icon-of:/Applications/Zed.app");
  });

  it("图标取不到只让那一条退回纯文字,不拖垮整份名单", async () => {
    const svc = createFilesService(deps({
      exists: (abs) => abs.endsWith("/Visual Studio Code.app") || abs.endsWith("/Zed.app"),
      appIcon: async (p) => {
        if (p.includes("Zed")) throw new Error("icns 坏了");
        return "ok";
      },
    }));
    expect((await svc.editors()).map((e) => e.icon)).toEqual(["ok", ""]);
  });
});

describe("reveal", () => {
  it("指定编辑器:走 open -a,传的是探出来的那份 bundle 名", () => {
    const openWith = vi.fn();
    const svc = createFilesService(deps({ openWith }));
    const r = svc.reveal(ROOT, "a.ts", "app", "Visual Studio Code");
    expect(r.ok).toBe(true);
    expect(openWith).toHaveBeenCalledWith("Visual Studio Code", "/w/a.ts");
  });

  it("名单外的 app 一律拒绝——菜单给什么就只能开什么", () => {
    const openWith = vi.fn();
    const svc = createFilesService(deps({ openWith }));
    const r = svc.reveal(ROOT, "a.ts", "app", "/tmp/evil.app");
    expect(!r.ok && r.kind).toBe("unknown-app");
    expect(openWith).not.toHaveBeenCalled();
  });


  it("外部打开同样过根内校验", () => {
    const openPath = vi.fn();
    const svc = createFilesService(deps({
      openPath, realpath: (p) => (p === ROOT ? ROOT : "/etc/passwd"),
    }));
    const r = svc.reveal(ROOT, "link.txt", "open");
    expect(!r.ok && r.kind).toBe("outside-root");
    expect(openPath).not.toHaveBeenCalled();
  });

  it("正常路径转给 shell", () => {
    const showInFolder = vi.fn();
    const svc = createFilesService(deps({ showInFolder }));
    const r = svc.reveal(ROOT, "a.ts", "folder");
    expect(r.ok).toBe(true);
    expect(showInFolder).toHaveBeenCalledWith("/w/a.ts");
  });
});
