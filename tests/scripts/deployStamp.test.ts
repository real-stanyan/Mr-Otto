// deploy-stamp.mjs 的判据（issue #791，ADR-0258）。
//
// 这个指纹回答的是「**此刻部署上去会不会改变什么**」。它有两个方向的失败，钉的
// 就是这两个：
//   · 漏报（该变没变）—— 一次真实的改动被判成「线上是当前的」，#790 原样复发；
//   · 误报（不该变却变了）—— 改 README 就说服务端落后，喊几次狼来了之后这条
//     检查就没人看了，而一条没人看的检查等于不存在。
//
// 所以最要紧的一条是「**传递依赖也算**」：协议进位那种提交（只改
// `src/shared/remote/cloudSession.ts`）一个字都没碰 `services/`，按路径去猜
// 「谁受影响」必然漏掉它——2026-09-08 协议 12→13 就是这个形状。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deployStamp, edgeBaseUrl, STAMP_TARGETS } from "../../scripts/deploy-stamp.mjs";

let root: string;

/** 一棵三层的小树：entry → mid → leaf，外加一个谁都没 import 的旁观者 */
async function seed(leaf = "export const v = 1;\n"): Promise<void> {
  await mkdir(join(root, "svc"), { recursive: true });
  await mkdir(join(root, "shared"), { recursive: true });
  await writeFile(join(root, "svc/entry.ts"), `import { mid } from "./mid.js";\nexport default mid;\n`);
  await writeFile(join(root, "svc/mid.ts"), `import { v } from "../shared/leaf.js";\nexport const mid = v + 1;\n`);
  await writeFile(join(root, "shared/leaf.ts"), leaf);
  await writeFile(join(root, "README.md"), "# 谁都没 import 我\n");
}

const stamp = (): Promise<string> =>
  deployStamp({ absWorkingDir: root, entry: "svc/entry.ts", platform: "neutral" });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "deploy-stamp-"));
  await seed();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("deployStamp", () => {
  it("同一份代码算两遍是同一个指纹（否则每次 check 都报落后）", async () => {
    expect(await stamp()).toBe(await stamp());
  });

  // 这一条是整个设计的理由：按 `services/**` 的路径去判，协议进位那种提交
  // （只动 src/shared/remote/）会被判成「与线上无关」，而它恰恰是最要命的那种
  it("**传递依赖**改了，指纹跟着变——哪怕它不在服务自己的目录里", async () => {
    const before = await stamp();
    await writeFile(join(root, "shared/leaf.ts"), "export const v = 2;\n");
    expect(await stamp()).not.toBe(before);
  });

  it("直接依赖改了当然也变", async () => {
    const before = await stamp();
    await writeFile(join(root, "svc/mid.ts"), `import { v } from "../shared/leaf.js";\nexport const mid = v + 2;\n`);
    expect(await stamp()).not.toBe(before);
  });

  // 误报那一侧：进不了 bundle 的东西改了不许动指纹
  it("没人 import 的文件改了，指纹不动（会误报的警报等于没有警报）", async () => {
    const before = await stamp();
    await writeFile(join(root, "README.md"), "# 改了文档\n");
    await writeFile(join(root, "shared/unused.ts"), "export const x = 1;\n");
    expect(await stamp()).toBe(before);
  });

  // 路径也进哈希：同一份内容换个文件名是另一份代码（import 解析会变）
  it("内容一样但文件改了名 = 另一个指纹", async () => {
    const before = await stamp();
    await writeFile(join(root, "svc/mid.ts"), `import { v } from "../shared/renamed.js";\nexport const mid = v + 1;\n`);
    await writeFile(join(root, "shared/renamed.ts"), "export const v = 1;\n");
    expect(await stamp()).not.toBe(before);
  });

  it("解析不出来的 import 一律 external，不让它把整次打包炸掉", async () => {
    await writeFile(join(root, "svc/entry.ts"), `import "cloudflare:workers";\nexport default 1;\n`);
    await expect(
      deployStamp({ absWorkingDir: root, entry: "svc/entry.ts", platform: "neutral", external: ["cloudflare:*"] })
    ).resolves.toMatch(/^[0-9a-f]{12}$/);
  });

  // 两个真实目标必须都算得出来——算不出来时 deploy 与 check 都会当场炸，
  // 但那要等到有人真去部署才发现
  it("仓库里那两个真实目标都算得出指纹", async () => {
    const repoRoot = join(__dirname, "../..");
    for (const target of Object.values(STAMP_TARGETS)) {
      expect(await deployStamp({ absWorkingDir: repoRoot, ...target })).toMatch(/^[0-9a-f]{12}$/);
    }
  });
});

describe("edgeBaseUrl", () => {
  // 自检要核的地址必须与客户端读的是同一个常量。在这里抄第二份的话，两边分家
  // 那天没有任何一处会报错——只会让自检对着一个空气地址报「通过」
  it("从 src/shared/edgeConfig.ts 现读，与客户端那份逐字相同", async () => {
    const repoRoot = join(__dirname, "../..");
    const { DEFAULT_EDGE_BASE_URL } = await import("../../src/shared/edgeConfig.js");
    expect(edgeBaseUrl(repoRoot)).toBe(DEFAULT_EDGE_BASE_URL);
  });

  it("常量被改名了要在这里响，不是退回一个写死的旧地址继续跑", async () => {
    await mkdir(join(root, "src/shared"), { recursive: true });
    await writeFile(join(root, "src/shared/edgeConfig.ts"), "export const SOMETHING_ELSE = \"https://x\";\n");
    expect(() => edgeBaseUrl(root)).toThrow(/DEFAULT_EDGE_BASE_URL/);
  });
});
