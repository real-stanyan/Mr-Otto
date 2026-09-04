// AGENTS.md 的 Hard rules 从"写在文档里"变成"跑在门禁里"(Harness Engineering:
// 架构约束要变成可执行检查,错误信息要带修法,不只是指出违规)。
//
// 六条边界。前两条是 AGENTS.md 的 Hard rules 原文,其余四条是各自 ADR 落下来的分层约束:
//   1. 工具实现只依赖 ExecutionWorld 接口,禁止直接 import fs / child_process
//   2. 渲染进程只通过 ShellBridge 与后端通信,禁止直接触碰 Node API
//   3. src/loop 不 import src/main —— turn 循环是纯逻辑层,装配(型号 id、便宜模型
//      通道、设置文件路径)是 main 的事(ADR-0064 的微压缩就踩在这条线上)
//   4. @modelcontextprotocol/sdk 只允许 src/main/mcpClient.ts import(ADR-0050)
//   5. src/shared 不碰 node builtin / electron —— 这一层手机端(Expo/RN)会直接 import
//      同一份源码,碰了 Node 就断了那条路
//   6. 移动端复用名单里的那批 src/session 投影文件,同样不碰 node builtin
//
// 5 和 6 的意义和前四条略有不同:它们把"src/shared 目前碰巧是纯的"这个**事实**,
// 变成一条会红的**规则**。名单写死在用例里 —— 想把新文件放进复用面得显式加进来。
//
// 纯 grep 级:读源码文本找 import 语句,不做 AST。简单到一眼能看懂,也够用——
// 这里挡的是"顺手"犯的错,不是刻意绕过。

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** 文件里所有 import/require 的模块说明符 */
function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const specs: string[] = [];
  const re = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) specs.push(m[1]!);
  return specs;
}

function offenders(dir: string, banned: (spec: string) => boolean): string[] {
  return walk(dir)
    .filter((f) => imports(f).some(banned))
    .map((f) => relative(ROOT, f));
}

const NODE_FS_OR_PROC = (s: string) =>
  /^(node:)?(fs|fs\/promises|child_process)$/.test(s);
const NODE_BUILTIN = (s: string) =>
  s.startsWith("node:") ||
  /^(fs|path|os|child_process|crypto|net|http|https|stream|util|events|electron)(\/|$)/.test(s);

describe("Hard rules(AGENTS.md)是门禁的一部分", () => {
  it("src/tools 不直接 import fs / child_process —— 工具只依赖 ExecutionWorld", () => {
    const bad = offenders(join(ROOT, "tools"), NODE_FS_OR_PROC);
    expect(
      bad,
      `这些工具直接碰了 Node fs/child_process:\n  ${bad.join("\n  ")}\n` +
        "修法:改走传进来的 world(world.fs.read / world.exec),让 LocalWorld 去碰真 fs;" +
        "需要新能力就在 src/world/executionWorld.ts 加接口,而不是绕过它"
    ).toEqual([]);
  });

  it("src/renderer 不 import Node/Electron 模块 —— 只走 window.otter(ShellBridge)", () => {
    const bad = offenders(join(ROOT, "renderer"), NODE_BUILTIN);
    expect(
      bad,
      `渲染层这些文件直接 import 了 Node/Electron 模块:\n  ${bad.join("\n  ")}\n` +
        "修法:把那段逻辑搬进主进程,在 src/shared/shellBridge.ts 加一条方法," +
        "src/preload 暴露、src/main/index.ts 实现,渲染层调 window.otter.xxx()"
    ).toEqual([]);
  });

  it("src/loop 不 import src/main —— 循环是纯逻辑,装配留给 main", () => {
    const bad = offenders(join(ROOT, "loop"), (s) => /^(\.\.\/)+main(\/|$)/.test(s));
    expect(
      bad,
      `src/loop 这些文件反向依赖了主进程:\n  ${bad.join("\n  ")}\n` +
        "修法:把那个常量/能力做成参数,由 src/main/index.ts 装配时注入" +
        "(如微压缩的 MICRO_MODEL 与 cheapAdapter,见 ADR-0064);" +
        "loop 只该依赖 session / model / shared / world"
    ).toEqual([]);
  });

  it("@modelcontextprotocol/sdk 只有 src/main/mcpClient.ts 能 import(ADR-0050)", () => {
    const bad = offenders(ROOT, (s) => s.startsWith("@modelcontextprotocol/")).filter(
      (f) => f !== "main/mcpClient.ts"
    );
    expect(
      bad,
      `这些文件越过 mcpClient 直接用了 MCP SDK:\n  ${bad.join("\n  ")}\n` +
        "修法:需要的能力加到 src/main/mcpClient.ts 的导出里,其它地方只依赖那层包装"
    ).toEqual([]);
  });

  // 这条守的是一个**只在 Electron 里现形**的失败:Electron 链的是 BoringSSL,
  // 它只在 AEAD API 里提供 ChaCha20-Poly1305,没注册进 EVP_get_cipherbyname 那张表。
  // 于是 createCipheriv("chacha20-poly1305", …) 在产品里抛 Unknown cipher,
  // 而 vitest 跑在真 Node(OpenSSL)上,同一行代码永远绿。
  // 实测 Electron 43.4.0:crypto.getCiphers() 里含 "chacha" 的条目一个都没有。
  //
  // 真机联调时它伪装成了"网络断流"——异常从 SSE 读循环里窜出去,被外层 catch
  // 当成连接错误。付出的代价是一整轮排查,所以这里钉死。
  it("远程加密不走 node 的 EVP 密码表(Electron 是 BoringSSL,没有 chacha)", () => {
    // 先剥注释再找:那个文件的头注里正当地引用了这两个名字来解释为什么不能用,
    // 直接 includes 会把解释本身当成违规
    const code = readFileSync(join(ROOT, "main/remoteCryptoNode.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const bad = ["createCipheriv", "createDecipheriv"].filter((n) => code.includes(n));
    expect(
      bad,
      `src/main/remoteCryptoNode.ts 用了 ${bad.join(" / ")}。\n` +
        "Electron 的 BoringSSL 没有 chacha20-poly1305 这个 EVP 名字,运行时会抛 Unknown cipher。" +
        "修法:AEAD 用 @noble/ciphers 的 chacha20poly1305(纯 JS,和手机端同一份实现,字节兼容)"
    ).toEqual([]);
  });

  it("src/shared 不 import 任何 node builtin / electron —— 这批文件手机端也要跑", () => {
    const bad = offenders(join(ROOT, "shared"), NODE_BUILTIN);
    expect(
      bad,
      `这些 shared 文件碰了 Node/Electron:\n  ${bad.join("\n  ")}\n` +
        "修法:src/shared 是三边共享的纯类型/纯逻辑层,手机端(Expo/RN)会直接 import 同一份," +
        "碰了 Node 就断了那条路。要用 Node 能力请放 src/main,或把能力收成一个注入接口" +
        "(见 src/shared/remote/crypto.ts 的 RemoteCryptoPrimitives)"
    ).toEqual([]);
  });

  // spec §7 的头两条安全不变量：OAuth token 不进事件日志（append-only，
  // 进去 = 永久泄漏）、不过 ShellBridge 回渲染层。它们目前靠**结构性保证**
  // 成立——McpAuthRecord 这个类型在 src/session/ 和 shellBridge.ts 里根本
  // 不出现。结构性保证是好的，但它正是那种会被一次无心的字段扩充悄悄推翻、
  // 且没有任何东西会变红的保证（终审 A）。这里把它钉成会红的规则。
  it("src/session 与 shellBridge 都不 import mcpAuthStore —— token 不进日志、不过桥", () => {
    const files = [...walk(join(ROOT, "session")), join(ROOT, "shared/shellBridge.ts")];
    const bad = files
      .filter((f) => imports(f).some((s) => /(^|\/)mcpAuthStore(\.js)?$/.test(s)))
      .map((f) => relative(ROOT, f));
    expect(
      bad,
      `这些文件 import 了 mcpAuthStore:\n  ${bad.join("\n  ")}\n` +
        "修法:OAuth token 只许留在 src/main/mcpAuthStore.ts 与 mcpClient.ts 之间。" +
        "事件日志是 append-only 的,token 进去就是永久泄漏;渲染层只该问" +
        '"这台授权了没"(McpServerStatus.status),拿不到也不需要 token 本身。' +
        "要展示授权状态请扩 McpServerStatus,不要把凭据记录搬过来"
    ).toEqual([]);
  });

  // issue #820：electron-builder **隐式**把 dependencies 整个打进 DMG，而
  // 桌面一行都不 import dockerode（src/world/dockerWorld.ts 只收注入的
  // ContainerLike，零 dockerode import）——它只有 services/runtime 那个
  // 跑在 VPS 上的 daemon 用。留在 dependencies 里的代价是每个用户的安装包
  // 里多背一套 dockerode/docker-modem/ssh2，而 ssh2 的可选原生件
  // cpu-features 与 mac 的 npmRebuild 有交互风险，门禁又跑不到 dist:mac。
  // 挪走一次不够：下一次 `npm i dockerode` 会默认写回 dependencies，
  // 而这件事没有任何症状——只有用户的下载体积变大。
  it("dockerode 不在 dependencies 里 —— 桌面不 import 它，别打进 DMG", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(
      pkg.dependencies?.dockerode,
      "dockerode 回到了 dependencies（大概率是一次 `npm i dockerode` 的默认行为）。" +
        "修法：挪进 devDependencies —— 它只服务 services/runtime 的 VPS daemon，" +
        "而 scripts/runtime-deploy.mjs 两栏都认（issue #820）"
    ).toBeUndefined();
    expect(
      pkg.devDependencies?.dockerode,
      "dockerode 从 devDependencies 里没了 —— services/runtime 的 daemon import 它，" +
        "tsc 会红。要删的话先把 daemon 那条 import 一起处理掉"
    ).toBeTruthy();
  });

  it("移动端复用的那批 src/session 文件不 import node builtin", () => {
    // store.ts(better-sqlite3)与 attachments.ts(node:fs)是**桌面专属**,不在复用面内。
    // 其余的投影函数手机端要跑 —— 名单写死在这里,新增文件想进复用面要显式加进来,
    // 而不是"碰巧还没碰 Node 就算数"
    const MOBILE_SAFE = [
      "events.ts", "deriveMessages.ts", "deriveSections.ts", "deriveTodos.ts",
      "deriveUsage.ts", "barrenTurns.ts", "activeSkills.ts", "microCompact.ts",
      "modelContextScan.ts", "persistencePolicy.ts",
    ];
    const bad = MOBILE_SAFE.filter((f) =>
      imports(join(ROOT, "session", f)).some(NODE_BUILTIN)
    );
    expect(
      bad,
      `这些 session 文件在移动端复用名单里,却碰了 Node:\n  ${bad.join("\n  ")}\n` +
        "修法:要么把 Node 依赖挪走,要么把文件从 MOBILE_SAFE 名单里去掉" +
        "(去掉意味着手机端不能用它投影,想清楚再改)"
    ).toEqual([]);
  });

  // #852：memories/ 的写路径必须只有一个口（src/main/memoryFiles.ts），云同步挂在它后面。
  // 判据：一个文件既 import 了 node:fs 又提到记忆路径符号，就是在绕过那个口。
  // memoryTopics.ts 是只读的组装根、projectRoot.ts 只定义目录名函数——白名单。
  it("碰 memories/ 路径的文件不 import node:fs —— 记忆写路径只有 memoryFiles.ts 一个口（#852）", () => {
    const MEMORY_PATH_SYMBOLS = /\b(memoryRelPath|topicRelPath|topicLabelRelPath|TOPICS_DIR|MEMORY_DIR|PROJECT_ROOT_FILE|PROJECT_MEMORY_FILE|PROJECT_MERGED_FILE)\b|["'`]memories\//;
    const allow = new Set(["main/memoryFiles.ts", "main/memoryTopics.ts", "main/projectRoot.ts"]);
    const bad = walk(ROOT)
      .filter((f) => !allow.has(relative(ROOT, f)))
      .filter((f) => imports(f).some((s) => /^node:fs(\/promises)?$/.test(s) || s === "fs" || s === "fs/promises"))
      .filter((f) => MEMORY_PATH_SYMBOLS.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(
      bad,
      `这些文件同时 import 了 node:fs 又碰记忆路径:\n  ${bad.join("\n  ")}\n` +
        "修法:读写 memories/ 一律走 src/main/memoryFiles.ts(createMemoryFiles);" +
        "它写完会通知 memorySync,绕过它 = 云端少一份"
    ).toEqual([]);
  });

  it("云会话给 LoopEngine 的 store 必须是 agentView 的产物（#928）", () => {
    const src = readFileSync("services/runtime/src/sessionService.ts", "utf8");
    // 判据取「new LoopEngine 那一段里 store: 后面跟的是什么」——不是全文搜
    // agentView（那样把它写在注释里也能骗过去）
    const block = src.slice(src.indexOf("new LoopEngine("));
    const storeLine = block.slice(0, block.indexOf("})")).match(/store:\s*([^,\n]+)/)?.[1] ?? "";
    expect(storeLine).toContain("agentView(");
  });
});
