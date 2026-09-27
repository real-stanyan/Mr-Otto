// 把 .demo/wechat/ 里的几份源拼成两个自包含的 html（#1386）。
//
//   node .demo/wechat/build.mjs [--artifact <输出目录>]
//
// 默认写 .demo/wechat-desktop.html 与 .demo/wechat-mobile.html（带 doctype，开文件 / 起个静态服务就能看）。
// --artifact 另写一份不带 doctype / html / head / body 的，给 claude.ai 的 Artifact 发布用（那边自己包骨架）。
//
// 像素脸（ottoface.js）是 src/shared/ottoFace 用 esbuild 打的 IIFE，挂在 window.OttoFace；
// 图标（icons.js）是从 lucide-react 抽出来的 path。两份都是生成物，改脸去改 src/shared/ottoFace 再重打。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

const here = import.meta.dirname;
const read = (f) => readFileSync(join(here, f), "utf8");
const parts = {
  "/*@@SHARED_CSS@@*/": read("shared.css"),
  "/*@@OTTOFACE@@*/": read("ottoface.js"),
  "/*@@ICONS@@*/": read("icons.js"),
  "/*@@SHARED_JS@@*/": read("shared.js"),
};

function assemble(src) {
  let out = read(src);
  for (const [k, v] of Object.entries(parts)) out = out.split(k).join(v);
  return out;
}

const HEAD = '<!doctype html>\n<html lang="zh">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n';

const outs = [
  ["desktop.src.html", "wechat-desktop.html"],
  ["mobile.src.html", "wechat-mobile.html"],
];
const artIdx = process.argv.indexOf("--artifact");
const artDir = artIdx > 0 ? process.argv[artIdx + 1] : null;

for (const [src, name] of outs) {
  let body;
  try { body = assemble(src); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
  const file = join(here, "..", name);
  writeFileSync(file, HEAD + body);
  console.log("wrote", file, Math.round((HEAD.length + body.length) / 1024) + "KB");
  if (artDir) {
    mkdirSync(artDir, { recursive: true });
    const af = join(artDir, name);
    // 发布那份：链接指向另一份 artifact 的地址由发布时替换，这里先去掉相对链接的「.html」依赖
    writeFileSync(af, body);
    console.log("wrote", af);
  }
}
