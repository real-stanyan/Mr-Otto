import { describe, it, expect } from "vitest";
import {
  CS_PROTOCOL_VERSION, csChannel, csCtlChannel, isCsChannel,
  encodeCs, decodeCsUp, decodeCsDown, validateRepoUrl,
  type CsUp,
} from "../../../src/shared/remote/cloudSession.js";
import { b64encode } from "../../../src/shared/remote/b64.js";

describe("cs 帧协议", () => {
  it("协议版本", () => {
    // 10 = #1044：加一对 delete / delete_result（控制房帧，形状同 archive）——
    //     彻底删除一条云会话。原来这颗钮不存在，理由是 0016 的 RLS 把
    //     wss_delete_publisher 钉死在 kind='package'；而那条前提只对客户端
    //     直连 Supabase 成立，runtime 拿的是 service key。
    // 9 = #993（ADR-0235）：归档也搬进控制房——archive 帧带 workspaceId + sessionId，
    //     新增 archive_result 回执（控制房没有 session_archived 广播可当回执）。
    // 8 = #991（ADR-0234）：仓库配置搬进控制房——config 帧带 workspaceId、新增
    //     workspace/workspace_state 读帧、config_result 带 workspaceId。
    // 7 = #981（ADR-0233）：云会话不再支持自带 key——config 帧去掉 model、
    //     welcome/config_result 去掉 model 一格、CsModelRoute 去掉 workspace。
    // 12 = #1066 那次进位（加一对 files_search / files_search_result 读帧）。
    // 11 = #1056 那次进位（加一对 files / files_result 读帧——工作文件夹看得见了）。
    // 6 = #957 第三批那次进位（CsUp 加 stop，CsDown 加
    //     say_result/approve_result/stop_result 三条回执）。
    // 5 = issue #945 那次进位（welcome/config_result 多了 modelRoute 一格）。
    // 4 = issue #844 那次进位（welcome/config_result 多了 model 一格，
    //     config 帧多了 model 字段、repoUrl 变成可选）。
    // 3 = issue #819 那次（denied 多了 rate_limited 码）。
    // 2 = issue #834 那次（welcome 多了 repo、下行多了 config_result）。
    // 握手是精确相等，两端同一个仓库一起发版——加字段照样进位，宁可让
    // 老客户端在 hello 那一步被明确拒绝，也不要它收到一条读不懂的 welcome
    // 之后静默少一格状态。**加一个枚举值同理**：老客户端的
    // isValidCsDeniedCode 认不出 rate_limited，整帧被 decodeCsDown 判成
    // null 静默丢掉，create() 于是白等满超时才回一句"云端无响应"
    expect(CS_PROTOCOL_VERSION).toBe(12);
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

// issue #819：新加的 denied 码要能被 decodeCsDown 认出来——认不出的后果是
// 整帧被判成 null 静默丢掉，客户端白等满超时
describe("rate_limited 码（issue #819）", () => {
  it("decodeCsDown 认得出，不被当成垃圾帧丢掉", () => {
    const frame = encodeCs({ t: "denied", code: "rate_limited" });
    expect(decodeCsDown(frame)).toEqual({ t: "denied", code: "rate_limited" });
  });
});

// 线上形状：config 帧两格各自可选，坏形状整帧判无效（ADR-0233 之后只剩仓库这一组）
describe("config 帧的字段（issue #844 → ADR-0233）", () => {
  it("老客户端多发的 model 字段被忽略，不判无效也不透传（ADR-0233）", () => {
    const withModel = b64encode(new TextEncoder().encode(JSON.stringify({ t: "config", workspaceId: "w", repoUrl: "https://a.com/x.git", model: { baseUrl: "https://a.com/v1", modelId: "m" } })));
    expect(decodeCsUp(withModel)).toEqual({ t: "config", workspaceId: "w", repoUrl: "https://a.com/x.git" });
  });

  it("只带 repoUrl 的照旧", () => {
    const frame: CsUp = { t: "config", workspaceId: "w", repoUrl: "https://github.com/x/y.git" };
    expect(decodeCsUp(encodeCs(frame))).toEqual(frame);
  });

  it("空 config 帧是合法的（服务端会回「没有要保存的内容」）", () => {
    expect(decodeCsUp(encodeCs({ t: "config", workspaceId: "w" }))).toEqual({ t: "config", workspaceId: "w" });
  });

  it("v5：welcome/config_result 的 modelRoute 一格能解回来，缺席或形状不对降级成 null", () => {
    const base = {
      t: "welcome" as const, v: CS_PROTOCOL_VERSION, sessionId: "s", lastSeq: 0,
      initiatorUid: null, ownerUid: "o", repo: null,
    };
    const hosted = decodeCsDown(encodeCs({ ...base, modelRoute: { kind: "hosted", model: "deepseek-v4-flash" } }));
    expect(hosted && hosted.t === "welcome" && hosted.modelRoute).toEqual({ kind: "hosted", model: "deepseek-v4-flash" });
    const blocked = decodeCsDown(encodeCs({ ...base, modelRoute: { kind: "blocked" } }));
    expect(blocked && blocked.t === "welcome" && blocked.modelRoute).toEqual({ kind: "blocked" });

    // 缺席 → null 而不是整帧判无效：解码这一侧永远向后兼容（硬规则），
    // 「这一格没带」和「探不到」是同一件事——都不许下结论
    const absent = decodeCsDown(b64encode(new TextEncoder().encode(JSON.stringify(base))));
    expect(absent && absent.t === "welcome" && absent.modelRoute).toBeNull();

    // hosted 却没带 model = 形状不对，同样降级成 null（整帧照收）
    const bad = decodeCsDown(
      b64encode(new TextEncoder().encode(JSON.stringify({ ...base, modelRoute: { kind: "hosted" } })))
    );
    expect(bad && bad.t === "welcome" && bad.modelRoute).toBeNull();

    // config_result 是同一格的第二个载体（回执与 welcome 同形）
    const cr = decodeCsDown(
      encodeCs({ t: "config_result", workspaceId: "w", ok: true, repo: null, modelRoute: { kind: "blocked" } })
    );
    expect(cr && cr.t === "config_result" && cr.modelRoute).toEqual({ kind: "blocked" });
    // ADR-0233：`workspace` 这一档没了，老 runtime 发来的降级成 null（整帧照收）
    const ws = decodeCsDown(
      b64encode(new TextEncoder().encode(JSON.stringify({ t: "config_result", workspaceId: "w", ok: true, repo: null, modelRoute: { kind: "workspace" } })))
    );
    expect(ws && ws.t === "config_result" && ws.modelRoute).toBeNull();
  });
});

// 协议 8（#991，ADR-0234）：仓库配置搬进控制房——config 帧必须说清是哪个工作区，
// 新增 workspace / workspace_state 一对读帧
describe("协议 8：控制房的 workspace / config 帧", () => {
  it("config 帧没有 workspaceId → 整帧无效（不知道在配谁的仓库）", () => {
    const raw = b64encode(new TextEncoder().encode(JSON.stringify({ t: "config", repoUrl: "https://a.com/x.git" })));
    expect(decodeCsUp(raw)).toBeNull();
  });
  it("workspace 读帧往返", () => {
    expect(decodeCsUp(encodeCs({ t: "workspace", workspaceId: "w" }))).toEqual({ t: "workspace", workspaceId: "w" });
    const bad = b64encode(new TextEncoder().encode(JSON.stringify({ t: "workspace" })));
    expect(decodeCsUp(bad)).toBeNull();
  });
  it("workspace_state 答复往返，repo/modelRoute 与 welcome 同一套归一化", () => {
    const down = decodeCsDown(encodeCs({
      t: "workspace_state", workspaceId: "w",
      repo: { url: "https://a.com/x.git", hasPat: true, clone: null },
      modelRoute: { kind: "hosted", model: "m" },
    }));
    expect(down).toEqual({
      t: "workspace_state", workspaceId: "w",
      repo: { url: "https://a.com/x.git", hasPat: true, clone: null },
      modelRoute: { kind: "hosted", model: "m" },
    });
    const bad = b64encode(new TextEncoder().encode(JSON.stringify({ t: "workspace_state", repo: null, modelRoute: null })));
    expect(decodeCsDown(bad)).toBeNull();
  });
  it("config_result 没有 workspaceId → 整帧无效", () => {
    const raw = b64encode(new TextEncoder().encode(JSON.stringify({ t: "config_result", ok: true, repo: null, modelRoute: null })));
    expect(decodeCsDown(raw)).toBeNull();
  });
});
