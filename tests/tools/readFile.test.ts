// read_file 的截断（issue #823）。上一版按**字符**截，于是这个上限根本
// 不保证"这条事件发得出去"——一屏中文能把 200_000 字符变成 600,112 字节，
// 是单事件预算的三倍。这里钉的就是那个真正的约束：**编码后的字节**。

import { describe, expect, it } from "vitest";
import { readFileTool } from "../../src/tools/readFile.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** frameHandler.ts 的 BACKLOG_CHUNK_BYTES（128 KiB）——两处各自写死，
    这条断言是它们之间的看门人（见 readFile.ts 上限那段注释） */
const CHUNK_BUDGET = 128 * 1024;

function worldReading(content: string): ExecutionWorld {
  return {
    fs: { read: async () => content, write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  };
}

async function readBack(content: string): Promise<string> {
  return String(await readFileTool.run({ path: "/x" }, worldReading(content)));
}

const bytesOf = (s: string): number => new TextEncoder().encode(s).byteLength;

describe("read_file 的截断按 UTF-8 字节（issue #823）", () => {
  it("没超上限的原样返回 —— 一个字节都不动", async () => {
    const content = "一行中文\nsecond line\n";
    expect(await readBack(content)).toBe(content);
  });

  it("纯 ASCII 超限：正文截到 128 KiB，且说清楚截了多少", async () => {
    const content = "a".repeat(CHUNK_BUDGET + 5_000);
    const out = await readBack(content);
    expect(out).toContain("文件内容被截断");
    expect(out).toContain(`原始 ${CHUNK_BUDGET + 5_000} 字节`);
    // 正文部分（警告尾巴之外）不超预算
    const body = out.slice(0, out.indexOf("\n\n[Warning:"));
    expect(bytesOf(body)).toBeLessThanOrEqual(CHUNK_BUDGET);
  });

  it("中文超限：**按字节**而不是按字符 —— 这正是上一版漏掉的那半", async () => {
    // 每个汉字 3 字节：60_000 字符 = 180_000 字节，远超预算，但字符数
    // 连旧上限（200_000 字符）的三分之一都不到，旧实现原样放行
    const content = "水".repeat(60_000);
    const out = await readBack(content);
    expect(out).toContain("文件内容被截断");
    const body = out.slice(0, out.indexOf("\n\n[Warning:"));
    expect(bytesOf(body)).toBeLessThanOrEqual(CHUNK_BUDGET);
  });

  it("不切在字符中间 —— 切点落在多字节字符里时退到边界，不留 U+FFFD", async () => {
    // 128 KiB 不是 3 的倍数（131072 = 3 × 43690 + 2），所以按字节硬切
    // 必然切在某个汉字的中间：退不回去就会解出一个 �
    const out = await readBack("水".repeat(60_000));
    const body = out.slice(0, out.indexOf("\n\n[Warning:"));
    expect(body).not.toContain("�");
    expect(bytesOf(body) % 3).toBe(0); // 全是完整的三字节汉字
  });

  it("整条结果（含警告尾巴）序列化后仍在单事件预算内", async () => {
    // 真正要挡住的东西：这个上限存在的理由是"这条 tool_result 发得出去"。
    // 中文最坏情况 + JSON 转义之后仍要留在预算里
    for (const content of ["a".repeat(400_000), "水".repeat(200_000)]) {
      const out = await readBack(content);
      expect(bytesOf(JSON.stringify(out))).toBeLessThanOrEqual(CHUNK_BUDGET + 2_048);
    }
  });
});
