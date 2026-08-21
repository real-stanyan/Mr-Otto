import { describe, it, expect } from "vitest";
import { parseMcpConfig, serializeMcpConfig } from "../../src/main/mcpConfig.js";
import type { McpServerConfig } from "../../src/shared/mcp.js";

describe("parseMcpConfig", () => {
  it("有 command = stdio", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { github: { command: "npx", args: ["-y", "s"], env: { T: "1" } } },
    }));
    expect(errors).toEqual([]);
    expect(servers["github"]).toEqual({
      kind: "stdio", command: "npx", args: ["-y", "s"], env: { T: "1" }, enabled: true,
    });
  });

  it("有 url = http", () => {
    const { servers } = parseMcpConfig(JSON.stringify({
      mcpServers: { linear: { url: "https://x/mcp", headers: { A: "b" } } },
    }));
    expect(servers["linear"]).toEqual({
      kind: "http", url: "https://x/mcp", headers: { A: "b" }, enabled: true,
    });
  });

  it("command 和 url 都有 = 报错，不猜，且记进 unrecognizedIds", () => {
    const { servers, errors, unrecognizedIds } = parseMcpConfig(JSON.stringify({
      mcpServers: { bad: { command: "npx", url: "https://x" } },
    }));
    expect(servers["bad"]).toBeUndefined();
    expect(errors.join()).toContain("bad");
    expect(unrecognizedIds).toEqual(["bad"]);
  });

  it("两个都没有 = 报错，且记进 unrecognizedIds", () => {
    const { errors, unrecognizedIds } = parseMcpConfig(JSON.stringify({ mcpServers: { bad: { args: [] } } }));
    expect(errors.join()).toContain("bad");
    expect(unrecognizedIds).toEqual(["bad"]);
  });

  it("enabled: false 认得", () => {
    const { servers } = parseMcpConfig(JSON.stringify({
      mcpServers: { off: { command: "x", enabled: false } },
    }));
    expect(servers["off"]!.enabled).toBe(false);
  });

  it("缺省字段补齐 —— args/env/headers 缺了就是空", () => {
    const { servers } = parseMcpConfig(JSON.stringify({ mcpServers: { s: { command: "x" } } }));
    expect(servers["s"]).toEqual({ kind: "stdio", command: "x", args: [], env: {}, enabled: true });
  });

  it("坏 JSON = 空清单 + 一条错，不抛，unrecognizedIds 也是空——一个 id 都取不出来", () => {
    const { servers, errors, unrecognizedIds } = parseMcpConfig("{ 这不是 json");
    expect(servers).toEqual({});
    expect(errors).toHaveLength(1);
    expect(unrecognizedIds).toEqual([]);
  });

  it("文件不存在（空串）= 空清单、零错误 —— 没配过不是错", () => {
    // fatal: false —— 空文件是「还没配过」，不是「读不出来」（issue #159）
    expect(parseMcpConfig("")).toEqual({ servers: {}, errors: [], unrecognizedIds: [], fatal: false });
  });

  it("一台坏的不带垮其它台，坏的那台记进 unrecognizedIds", () => {
    const { servers, errors, unrecognizedIds } = parseMcpConfig(JSON.stringify({
      mcpServers: { good: { command: "x" }, bad: {} },
    }));
    expect(servers["good"]).toBeDefined();
    expect(errors).toHaveLength(1);
    expect(unrecognizedIds).toEqual(["bad"]);
  });
});

describe("serializeMcpConfig", () => {
  it("保留用户手写的未知顶层字段 —— 不能替他删", () => {
    const prev = JSON.stringify({ $schema: "https://x", mcpServers: {}, myNote: 1 });
    const out = JSON.parse(serializeMcpConfig(prev, {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(out["$schema"]).toBe("https://x");
    expect(out["myNote"]).toBe(1);
  });

  it("保留某台 server 上的未知字段", () => {
    const prev = JSON.stringify({ mcpServers: { s: { command: "old", timeout: 99 } } });
    const out = JSON.parse(serializeMcpConfig(prev, {
      s: { kind: "stdio", command: "new", args: [], env: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["timeout"]).toBe(99);
    expect(out["mcpServers"]["s"]["command"]).toBe("new");
  });

  it("删掉的 server 真的没了", () => {
    const prev = JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } } });
    const out = JSON.parse(serializeMcpConfig(prev, {
      a: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(Object.keys(out["mcpServers"])).toEqual(["a"]);
  });

  it("enabled 为 true 时不写进文件 —— 那是缺省值，写了是噪音", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["enabled"]).toBeUndefined();
  });

  // issue #158：enabled 的写回逻辑与 kind 无关（那一行在两条分支之外），
  // 但从前只有 stdio 一路被钉住——没有任何东西保证这个假设成立
  it.each<[string, McpServerConfig]>([
    ["stdio", { kind: "stdio", command: "x", args: [], env: {}, enabled: false }],
    ["http", { kind: "http", url: "https://x", headers: {}, enabled: false }],
  ])("enabled 为 false 时写进去（%s）", (_kind, cfg) => {
    const out = JSON.parse(serializeMcpConfig("", { s: cfg }));
    expect(out["mcpServers"]["s"]["enabled"]).toBe(false);
  });

  it.each<[string, McpServerConfig]>([
    ["stdio", { kind: "stdio", command: "x", args: [], env: {}, enabled: true }],
    ["http", { kind: "http", url: "https://x", headers: {}, enabled: true }],
  ])("enabled 为 true 时不写进文件（%s）", (_kind, cfg) => {
    const out = JSON.parse(serializeMcpConfig("", { s: cfg }));
    expect(out["mcpServers"]["s"]["enabled"]).toBeUndefined();
  });

  it("enabled 为 false 时写进去", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: false },
    }));
    expect(out["mcpServers"]["s"]["enabled"]).toBe(false);
  });

  // F1 half 2：这条测试原先断言"prev 坏了就从空对象重建"——那正是被本次
  // 修复消灭的 bug（reviewer 的 scenario B：整份文件语法错误时，点一次
  // 新建/保存会把 mcp.json 悄悄改写成只剩新建的这一台，magic 般抹掉其余
  // server 和它们的凭据）。新行为是拒绝这次写，抛错，让调用方（mcpHub）把
  // 这个错误一路穿透给用户，而不是安静地"重建"出一份看似合法、实则已经
  // 删光了别人数据的文件。这条断言如果被人改回旧行为（不抛、返回重建后的
  // JSON），这条测试会失败。
  it("prev 是坏 JSON 时拒绝写——不能从空对象重建，那等于把其余内容悄悄删光", () => {
    expect(() => serializeMcpConfig("{ 坏", {
      s: { kind: "http", url: "https://x", headers: {}, enabled: true },
    })).toThrow(/不是合法 JSON/);
  });

  it("prev 是空串（没配过）时不算坏 JSON——从空对象起步，不抛", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "http", url: "https://x", headers: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["url"]).toBe("https://x");
  });

  // F1 half 1：unrecognizedIds 里的 id 即使不在 `servers` 参数里，写回时
  // 也必须原样留着——它没能解析进 servers 不代表用户删掉了它。如果
  // serializeMcpConfig 里"解析不动的那几台原样放回去"那段循环被删掉，
  // `broken` 会从输出里消失，这条测试就会失败。
  it("unrecognizedIds 里的 id 在保存邻居时原样留在磁盘上", () => {
    const prev = JSON.stringify({
      mcpServers: {
        good: { command: "npx" },
        broken: { timeout: 30 }, // 既没有 command 也没有 url，parseMcpConfig 会判它进 unrecognizedIds
      },
    });
    const out = JSON.parse(serializeMcpConfig(
      prev,
      { good: { kind: "stdio", command: "npx", args: [], env: {}, enabled: true } },
      ["broken"]
    ));
    expect(out["mcpServers"]["broken"]).toEqual({ timeout: 30 });
    expect(out["mcpServers"]["good"]["command"]).toBe("npx");
  });

  it("unrecognizedIds 里的 id 不在 prevServers 上时安静跳过——不凭空造出一条空记录", () => {
    const out = JSON.parse(serializeMcpConfig(
      JSON.stringify({ mcpServers: { good: { command: "npx" } } }),
      { good: { kind: "stdio", command: "npx", args: [], env: {}, enabled: true } },
      ["从未出现过的id"]
    ));
    expect(Object.keys(out["mcpServers"])).toEqual(["good"]);
  });
});

// issue #159：调用方必须分得开「读不出 server」和「这份文件说没有 server」——
// 分不开的时候 mcpHub 会把整份文件的语法错误当成「用户删光了 server」
describe("parseMcpConfig 的 fatal（issue #159）", () => {
  it("整份 JSON 解析不动 = fatal", () => {
    const out = parseMcpConfig("{ 这不是 JSON");
    expect(out.fatal).toBe(true);
    expect(out.servers).toEqual({});
  });

  it("空文件不是 fatal —— 那是货真价实的「还没配过」", () => {
    expect(parseMcpConfig("").fatal).toBe(false);
    expect(parseMcpConfig("   \n  ").fatal).toBe(false);
  });

  it("单条节点坏掉不是 fatal —— 一台坏的不带垮其它台，这条口径没变", () => {
    const out = parseMcpConfig(
      JSON.stringify({ mcpServers: { good: { command: "npx" }, bad: { note: "既没 command 也没 url" } } })
    );
    expect(out.fatal).toBe(false);
    expect(Object.keys(out.servers)).toEqual(["good"]);
    expect(out.unrecognizedIds).toEqual(["bad"]);
  });

  it("合法但没有 mcpServers 的文件不是 fatal", () => {
    expect(parseMcpConfig(JSON.stringify({ $schema: "x" })).fatal).toBe(false);
  });
});
