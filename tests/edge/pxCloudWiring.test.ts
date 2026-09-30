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
    expect(call).toMatch(/isCloudServerId\(serverId\)[\s\S]*cloudRefresh\(/);
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
