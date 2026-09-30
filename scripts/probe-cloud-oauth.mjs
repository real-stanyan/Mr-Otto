// 上线前的一次性探针（#1430，spec §14）：
// 目录里的 OAuth 应用当初是用本机回环回调实测的；手机接应用改走 edge 的 https 回调，
// 所以要逐条再跑一遍「前半段」（发现 → 动态注册），走到「浏览器该开了」才算过。
//
// 用法（不进门禁，用 tsx 直接 import TS 纯函数）：
//   npx tsx scripts/probe-cloud-oauth.mjs [--callback https://edge.mrotto.agency/px/v1/cloud/callback]
//
// 副作用：注册会在各厂商那边真的留下一个 OAuth client（无害但会累积）。
// 只在上线前跑一次，结果与日期写进 #1430 评论；FAIL 的条目按原因填进 src/shared/mobileConnectors.ts 的
// MOBILE_OAUTH_BLOCKED（no_dcr 写「这个应用暂时不能在手机上直接登录，去电脑上接」，
// register 拒 redirect_uri 写「它不接受从云端回来的登录」）。
import { MCP_CATALOG } from "../src/shared/mcpCatalog.ts";
import { DEFAULT_EDGE_BASE_URL } from "../src/shared/edgeConfig.ts";
import { discoverOAuth, registerClient } from "../services/edge/src/pxOAuth.ts";

const i = process.argv.indexOf("--callback");
const callback = i > 0 && process.argv[i + 1] ? process.argv[i + 1] : `${DEFAULT_EDGE_BASE_URL}/px/v1/cloud/callback`;
if (!callback.startsWith("https://")) {
  console.error(`回调地址必须是 https：${callback}`);
  process.exit(2);
}
console.log(`回调地址：${callback}\n`);

const f = (url, init) => fetch(url, init);
const rows = [];
for (const e of MCP_CATALOG.filter((x) => x.transport === "http" && x.auth === "oauth")) {
  if (/\{\w+\}/.test(e.url ?? "")) {
    rows.push([e.id, "skip", "url 带参数，手测"]);
    continue;
  }
  const d = await discoverOAuth(f, e.url);
  if (!d.ok) {
    rows.push([e.id, "FAIL", `${d.code}: ${d.message}`]);
    continue;
  }
  const r = await registerClient(f, d.meta, callback);
  rows.push([e.id, r.ok ? "ok" : "FAIL", r.ok ? "" : `${r.code}: ${r.message}`]);
}
for (const [id, s, why] of rows) console.log(`${s.padEnd(4)} ${id.padEnd(24)} ${why}`);
const ok = rows.filter((r) => r[1] === "ok").length;
const skipped = rows.filter((r) => r[1] === "skip").length;
console.log(`\n${ok}/${rows.length} ok，${skipped} 条跳过（url 带参数，手测）`);
