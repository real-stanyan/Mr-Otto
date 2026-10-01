// 生成物里有 require("…png")（Metro 的资源写法），vitest 直接 import 会去解析那些 png。
// 这里把那个文件当文本读：svg 那张表 eval 出来，png 那张只取键。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "..", "..", "mobile/src/machine/appIcons.generated.ts"), "utf8");

const svgBlock = src.slice(src.indexOf("APP_ICON_SVG"), src.indexOf("export const APP_ICON_PNG"));
export const APP_ICON_SVG: Record<string, string> = Object.fromEntries(
  [...svgBlock.matchAll(/^  ("[^"]+"): (".*"),$/gm)].map((m) => [JSON.parse(m[1]!) as string, JSON.parse(m[2]!) as string])
);

const pngBlock = src.slice(src.indexOf("export const APP_ICON_PNG"));
export const APP_ICON_PNG_KEYS: string[] = [...pngBlock.matchAll(/^  "([^"]+)": require\(/gm)].map((m) => m[1]!);
