import { describe, it, expect } from "vitest";
import { parseMcpConfig, serializeMcpConfig } from "../../src/main/mcpConfig.js";

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

  it("command 和 url 都有 = 报错，不猜", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { bad: { command: "npx", url: "https://x" } },
    }));
    expect(servers["bad"]).toBeUndefined();
    expect(errors.join()).toContain("bad");
  });

  it("两个都没有 = 报错", () => {
    const { errors } = parseMcpConfig(JSON.stringify({ mcpServers: { bad: { args: [] } } }));
    expect(errors.join()).toContain("bad");
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

  it("坏 JSON = 空清单 + 一条错，不抛", () => {
    const { servers, errors } = parseMcpConfig("{ 这不是 json");
    expect(servers).toEqual({});
    expect(errors).toHaveLength(1);
  });

  it("文件不存在（空串）= 空清单、零错误 —— 没配过不是错", () => {
    expect(parseMcpConfig("")).toEqual({ servers: {}, errors: [] });
  });

  it("一台坏的不带垮其它台", () => {
    const { servers, errors } = parseMcpConfig(JSON.stringify({
      mcpServers: { good: { command: "x" }, bad: {} },
    }));
    expect(servers["good"]).toBeDefined();
    expect(errors).toHaveLength(1);
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

  it("enabled 为 false 时写进去", () => {
    const out = JSON.parse(serializeMcpConfig("", {
      s: { kind: "stdio", command: "x", args: [], env: {}, enabled: false },
    }));
    expect(out["mcpServers"]["s"]["enabled"]).toBe(false);
  });

  it("prev 是坏 JSON 时不吞掉这次保存 —— 从空对象重建", () => {
    const out = JSON.parse(serializeMcpConfig("{ 坏", {
      s: { kind: "http", url: "https://x", headers: {}, enabled: true },
    }));
    expect(out["mcpServers"]["s"]["url"]).toBe("https://x");
  });
});
