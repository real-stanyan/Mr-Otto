// worker.ts 进不了 vitest（要 cloudflare:workers），这几条接线的失败全是静默的——
// 读源码钉住（同 ADR-0305 / 0308 的做法）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync(new URL("../../services/edge/src/worker.ts", import.meta.url), "utf8");
const escrow = src.slice(src.indexOf("export class Escrow"), src.indexOf("function supa("));

describe("Escrow DO 接线", () => {
  it("grants 与 call 都过合并视图，不再只读 sealed", () => {
    const grants = escrow.slice(escrow.indexOf('op === "grants"'), escrow.indexOf('op === "audit"'));
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    expect(grants).toMatch(/this\.merged\(\)/);
    expect(call).toMatch(/this\.merged\(\)/);
  });
  it("桌面的 put / delete 只碰 sealed，不碰 cloud", () => {
    const put = escrow.slice(escrow.indexOf('op === "put"'), escrow.indexOf('op === "grants"'));
    expect(put).not.toMatch(/"cloud"/);
    expect(put).toMatch(/storage\.delete\("sealed"\)/);
  });
  it("cloud 那台 401 走 cloudRefresh，不走猜 discovery 的 pxRefreshTokens", () => {
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    const at401 = call.slice(call.indexOf('r.code === "upstream_auth"'));
    const cloudBranch = at401.slice(at401.indexOf("isCloudServerId(serverId)"), at401.indexOf("pxRefreshTokens("));
    expect(cloudBranch).toMatch(/cloudRefresh\(/);
    expect(cloudBranch).not.toMatch(/pxRefreshTokens/);
  });
  it("cloudRefresh 回 null 之后重读箱子分两种：needs_login 409 / 其余 502 refresh_failed", () => {
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    const at401 = call.slice(call.indexOf('r.code === "upstream_auth"'));
    const cloudBranch = at401.slice(at401.indexOf("isCloudServerId(serverId)"), at401.indexOf("pxRefreshTokens("));
    const afterRefresh = cloudBranch.slice(cloudBranch.indexOf("cloudRefresh("));
    expect(afterRefresh).toMatch(/cloudNeedsLogin\(await this\.cloudBox\(\), serverId\)/);
    expect(afterRefresh).toMatch(/code: "needs_login"[\s\S]*CLOUD_TEXT\.needsLogin/);
    expect(afterRefresh).toMatch(/status: 502, code: "refresh_failed"[\s\S]*CLOUD_TEXT\.refreshFailed/);
    // cloud 的 upstream_auth 到不了桌面那句「托管凭据已失效」
    expect(afterRefresh).not.toMatch(/upstream_auth/);
  });
  it("桌面 sealed 自刷：网络先行、之后读 this.doc() 并只展开 sealedDoc，不碰合并视图", () => {
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    const desktop = call.slice(call.indexOf("pxRefreshTokens("), call.indexOf("if (!r.ok) {"));
    expect(desktop.indexOf("this.doc()")).toBeGreaterThan(desktop.indexOf("pxRefreshTokens("));
    expect(desktop).toMatch(/const sealedDoc = await this\.doc\(\)/);
    expect(desktop).toMatch(/\.\.\.sealedDoc,/);
    expect(desktop).not.toMatch(/\.\.\.doc,/);
    expect(desktop).toMatch(/storage\.put\("sealed"/);
  });
  it("needs_login 只回给「若这台是活的就过得了闸」的调用者（不泄露存在性）", () => {
    const call = escrow.slice(escrow.indexOf('op === "call"'));
    const gateFail = call.slice(call.indexOf("if (!gate.ok)"), call.indexOf("const fetchLike"));
    expect(gateFail).toMatch(/status: "ok" as const/);
    // needs_login 的 409 只在「活视图」过闸时才回
    expect(gateFail).toMatch(/pxGate\(liveDoc,[^)]*\)[^\n]*\.ok\) \{\s*await this\.audit[\s\S]*code: "needs_login"/);
  });
  it("homeIdOf / isMember 外呼抛了按 null / false", () => {
    const deps = escrow.slice(escrow.indexOf("private cloudDeps"), escrow.indexOf("private async audit"));
    const home = deps.slice(deps.indexOf("homeIdOf:"), deps.indexOf("isMember:"));
    const member = deps.slice(deps.indexOf("isMember:"), deps.indexOf("log:"));
    expect(home).toMatch(/try \{[\s\S]*\} catch \{ return null; \}/);
    expect(member).toMatch(/try \{[\s\S]*\} catch \{ return false; \}/);
  });
  it("回调地址直接取生产默认常量，不再调 edgeBaseUrl(...)", () => {
    expect(src).toMatch(/callbackUrl: `\$\{DEFAULT_EDGE_BASE_URL\}\/px\/v1\/cloud\/callback`/);
    expect(src).not.toMatch(/edgeBaseUrl\(/);
  });
  it("atomic 用 blockConcurrencyWhile", () => {
    expect(escrow).toMatch(/atomic:\s*\(fn\)\s*=>\s*this\.ctx\.blockConcurrencyWhile\(fn\)/);
  });
  it("五个 cloud op 都接上了", () => {
    for (const op of ["cloud_connect", "cloud_callback", "cloud_view", "cloud_grant", "cloud_remove"]) {
      expect(escrow).toContain(`op === "${op}"`);
    }
  });
});
