// #1430 手机上接应用的可点 demo。把 wechat demo 的令牌 / 图标与**真目录**（只要 http、去掉本机工具）拼成一份自包含 html。
//
//   npx tsx .demo/connectors/build.mjs      → 写 .demo/mobile-connectors.html
//
// 目录现读 src/shared/mcpCatalog.ts，不抄一份：demo 里列出来的就是手机上真会列出来的那些。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOG_CATEGORIES, MCP_CATALOG } from "../../src/shared/mcpCatalog.ts";

const here = import.meta.dirname;
const read = (f) => readFileSync(join(here, f), "utf8");

const catalog = MCP_CATALOG.filter((e) => e.transport === "http" && e.category !== "本机工具").map((e) => ({
  id: e.id, name: e.name, description: e.description, category: e.category, auth: e.auth,
  params: e.params.map((p) => ({ name: p.name, description: p.description, required: p.required })),
  ...(e.blocked ? { blocked: e.blocked } : {}),
}));
const categories = CATALOG_CATEGORIES.filter((c) => c !== "本机工具");

const body = read("mobile.src.html")
  .split("/*@@SHARED_CSS@@*/").join(read("../wechat/shared.css"))
  .split("/*@@ICONS@@*/").join(read("../wechat/icons.js"))
  .split("/*@@CATALOG@@*/").join(`const CATALOG = ${JSON.stringify(catalog)};\nconst CATEGORIES = ${JSON.stringify(categories)};`);

const HEAD = '<!doctype html>\n<html lang="zh">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';
const out = join(here, "..", "mobile-connectors.html");
writeFileSync(out, HEAD + body);
console.log("wrote", out, Math.round((HEAD.length + body.length) / 1024) + "KB", `${catalog.length} 条 http 目录`);
