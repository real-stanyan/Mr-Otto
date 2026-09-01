import { describe, it, expect } from "vitest";
import {
  CS_PROTOCOL_VERSION, csChannel, csCtlChannel, isCsChannel,
  encodeCs, decodeCsUp, decodeCsDown, validateRepoUrl,
} from "../../../src/shared/remote/cloudSession.js";

describe("cs 帧协议", () => {
  it("协议版本", () => {
    // 2 = issue #834 那次进位（welcome 多了 repo、下行多了 config_result）。
    // 握手是精确相等，两端同一个仓库一起发版——加字段照样进位，宁可让
    // 老客户端在 hello 那一步被明确拒绝，也不要它收到一条读不懂的 welcome
    // 之后静默少一格状态
    expect(CS_PROTOCOL_VERSION).toBe(2);
  });
  it("房名生成", () => {
    expect(csCtlChannel()).toBe("cs-ctl");
    expect(csChannel("w1", "s1")).toBe("cs-w1-s1");
  });
  it("up 帧 roundtrip + 未知形状回 null", () => {
    const hello = { t: "hello" as const, v: CS_PROTOCOL_VERSION, jwt: "j" };
    expect(decodeCsUp(encodeCs(hello))).toEqual(hello);
    const say = { t: "say" as const, text: "干活", mention: true };
    expect(decodeCsUp(encodeCs(say))).toEqual(say);
    expect(decodeCsUp(encodeCs({ t: "nope" } as never))).toBeNull();
    expect(decodeCsUp("!!!not-b64")).toBeNull();
  });
  it("down 帧 roundtrip", () => {
    const ev = { t: "event" as const, event: { type: "turn_ended", sessionId: "s", seq: 3, ts: 1 } as never };
    expect(decodeCsDown(encodeCs(ev))).toEqual(ev);
    const denied = { t: "denied" as const, code: "not_member" as const };
    expect(decodeCsDown(encodeCs(denied))).toEqual(denied);
  });
  it("串台：CsDown 消息格式错误回 null", () => {
    // CsDown 中 backlog 不应该有 afterSeq（那是 CsUp 的字段）
    expect(decodeCsDown(encodeCs({ t: "backlog", afterSeq: 1 } as never))).toBeNull();
  });
  it("串台：CsUp 消息格式错误回 null", () => {
    // CsUp 中 backlog 不应该有 events/done（那是 CsDown 的字段）
    expect(decodeCsUp(encodeCs({ t: "backlog", events: [], done: true } as never))).toBeNull();
  });
  it("say.text 上限：超 64KiB 拒编码", () => {
    expect(() => encodeCs({ t: "say", text: "x".repeat(65 * 1024), mention: false })).toThrow();
  });
  it("mention 是显式布尔，不做文本猜测", () => {
    const m = decodeCsUp(encodeCs({ t: "say", text: "@Agent 干活", mention: false }));
    expect(m && m.t === "say" && m.mention).toBe(false);
  });
  it("整帧上限：超 MAX_FRAME_BYTES 拒编码", () => {
    // 构造一个包含大量事件的 backlog 帧，超过整帧限制
    const hugeEvents = Array(10000)
      .fill(null)
      .map((_, i) => ({
        type: "say_message" as const,
        sessionId: "s",
        seq: i,
        ts: Date.now(),
        text: "x".repeat(100),
      }));
    const msg = { t: "backlog" as const, events: hugeEvents, done: false } as never;
    expect(() => encodeCs(msg)).toThrow(/cs frame exceeds/);
  });

  // isCsChannel 是 edge.ts 角色收口的判据（终审 C1，精确格式化于终审复审
  // R1）：房名的构造（csChannel/csCtlChannel）与识别（isCsChannel）同源于
  // 这个文件，这里直接钉住识别函数本身的边界，不必每次都绕道 HTTP 层
  describe("isCsChannel — 精确格式匹配，不是前缀匹配（终审复审 R1）", () => {
    it("cs-ctl 与 csChannel() 生成的真实 UUID 房名都判定为 true", () => {
      expect(isCsChannel(csCtlChannel())).toBe(true);
      const real = csChannel("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
      expect(isCsChannel(real)).toBe(true);
    });

    it("非 UUID 的两段（比如测试里常用的 w1/s1）判定为 false——房名格式必须是精确的 UUID 对", () => {
      expect(isCsChannel(csChannel("w1", "s1"))).toBe(false);
    });

    it("以 cs- 开头但不是精确格式的随机 base64url 串判定为 false（R1 的原始复现：好友代理 channelId 撞前缀）", () => {
      // 43 字符，字母表含 -/_，贴近 b64encode(randomBytes(32)) 的真实长度，
      // 但不是 cs-<uuid>-<uuid> 的形状
      expect(isCsChannel("cs-Qx7mZ2pL9vN4wR8tY1zA6bC3dE5fG0hJ_mK-lMnO")).toBe(false);
    });

    it("大小写混淆的 UUID（非规范小写形式）判定为 false——workspaceId/sessionId 的规范文本形式都是小写", () => {
      const upper = csChannel("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")
        .toUpperCase();
      expect(isCsChannel(upper)).toBe(false);
    });

    it("完全不相关的字符串、空字符串、只差一个字符的变体都判定为 false", () => {
      expect(isCsChannel("")).toBe(false);
      expect(isCsChannel("cs-")).toBe(false);
      expect(isCsChannel("Cs-ctl")).toBe(false); // 大小写敏感
      expect(isCsChannel("xcs-ctl")).toBe(false); // 前缀之前多一个字符
      expect(isCsChannel("cs-ctl-extra")).toBe(false); // 后面多余的内容
      const real = csChannel("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222");
      expect(isCsChannel(`${real}-extra`)).toBe(false); // 合法房名后面缀了尾巴
    });
  });
});

/** 仓库地址的结构化白名单（issue #834）。刻意不是"检测有没有藏凭据"那种
    黑名单——那条路在 #821 被复审连破三轮，教训写在 lib/cloudRepoUrl.ts 的
    文件头。这里只问 URL 解析器自己答得上来的四个问题。 */
describe("validateRepoUrl", () => {
  it("普通 https 地址放行，回的是 trim 过的原串（不重新序列化）", () => {
    expect(validateRepoUrl("  https://github.com/acme/widgets.git  ")).toEqual({
      ok: true,
      url: "https://github.com/acme/widgets.git",
    });
  });

  it("带 userinfo 的一律拒——凭据在 git URL 里只能住在这儿，这是结构性判据", () => {
    for (const url of [
      "https://ghp_token@github.com/acme/widgets.git",
      "https://user:pass@github.com/acme/widgets.git",
    ]) {
      const r = validateRepoUrl(url);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.message).toContain("token");
    }
  });

  it("非 https（http / file / ext / ssh）一律拒——沙箱里没有 SSH key，ext:: 会执行任意命令", () => {
    for (const url of ["http://github.com/a/b.git", "file:///etc/passwd", "ext::sh -c whoami"]) {
      expect(validateRepoUrl(url).ok).toBe(false);
    }
  });

  it("scp 语法（git@host:path）拒，且给的是「换 https」而不是「格式错误」", () => {
    const r = validateRepoUrl("git@github.com:acme/widgets.git");
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toContain("https");
  });

  it("空串 / 超长 拒", () => {
    expect(validateRepoUrl("   ").ok).toBe(false);
    expect(validateRepoUrl(`https://github.com/${"x".repeat(3000)}`).ok).toBe(false);
  });

  it("路径里带 @ 的合法地址不误伤（@ 在 path 里不是 userinfo）", () => {
    expect(validateRepoUrl("https://github.com/acme/widgets@v2.git").ok).toBe(true);
  });
});
