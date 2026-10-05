// create_document 印 PDF 用的系统字体（#1683）：按文字挑（documents/scripts.ts），从系统字体目录读。
//
// VPS（Ubuntu）上要装：`sudo apt-get install -y fonts-noto-cjk fonts-noto-core fonts-dejavu-core`——
// 中日韩一个 .ttc 里四套字形（简 / 繁 / 日 / 韩），泰文、天城文在 noto-core 里。缺了哪种，那种文字的 PDF 出不来，
// 工具会说清楚、让模型改做 Word（documents/pdf.ts 的 DocumentError），不印豆腐块。
// Windows 那几行是给本机模拟（tests/runtime/sim）用的。字体集（.ttc）要写 PostScript 名，名字用 fontkit 实测过。
import { existsSync, readFileSync } from "node:fs";
import type { PdfFont, PdfFonts } from "./documents/pdf.js";
import type { CjkVariant, Script } from "./documents/scripts.js";

type Candidate = { path: string; family?: string };

const NOTO_CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK";
const NOTO = "/usr/share/fonts/truetype/noto";
const WIN = "C:/Windows/Fonts";
const NOTO_CJK_LANG: Record<CjkVariant, string> = { sc: "sc", tc: "tc", jp: "jp", kr: "kr" };

function candidates(script: Script, bold: boolean, variant: CjkVariant): Candidate[] {
  const w = bold ? "Bold" : "Regular";
  switch (script) {
    case "cjk": {
      const win: Candidate[] =
        variant === "jp" ? [{ path: `${WIN}/${bold ? "YuGothB" : "YuGothR"}.ttc`, family: bold ? "YuGothic-Bold" : "YuGothic-Regular" }] :
        variant === "kr" ? [{ path: `${WIN}/${bold ? "malgunbd" : "malgun"}.ttf` }] :
        variant === "tc" ? [{ path: `${WIN}/${bold ? "msjhbd" : "msjh"}.ttc`, family: bold ? "MicrosoftJhengHeiBold" : "MicrosoftJhengHeiRegular" }] :
        [{ path: `${WIN}/${bold ? "msyhbd" : "msyh"}.ttc`, family: bold ? "MicrosoftYaHei-Bold" : "MicrosoftYaHei" }];
      return [{ path: `${NOTO_CJK}-${w}.ttc`, family: `NotoSansCJK${NOTO_CJK_LANG[variant]}-${w}` }, ...win];
    }
    case "thai":
      return [{ path: `${NOTO}/NotoSansThai-${w}.ttf` }, { path: `${WIN}/${bold ? "LeelaUIb" : "LeelawUI"}.ttf` }];
    case "deva":
      return [{ path: `${NOTO}/NotoSansDevanagari-${w}.ttf` }, { path: `${WIN}/Nirmala.ttc`, family: bold ? "NirmalaUI-Bold" : "NirmalaUI" }];
    case "latin":
      return [
        { path: `${NOTO}/NotoSans-${w}.ttf` },
        { path: `/usr/share/fonts/truetype/dejavu/DejaVuSans${bold ? "-Bold" : ""}.ttf` },
        { path: `${WIN}/${bold ? "arialbd" : "arial"}.ttf` },
      ];
  }
}

export function createSystemFonts(exists: (p: string) => boolean = existsSync, read: (p: string) => Uint8Array = (p) => readFileSync(p)): PdfFonts {
  const cache = new Map<string, Uint8Array>();
  return {
    get(script, o): PdfFont | null {
      for (const c of candidates(script, o.bold, o.variant ?? "sc")) {
        if (!exists(c.path)) continue;
        let data = cache.get(c.path);
        if (data === undefined) {
          try {
            data = read(c.path);
          } catch {
            continue;
          }
          cache.set(c.path, data);
        }
        return { data, ...(c.family !== undefined ? { family: c.family } : {}) };
      }
      return null;
    },
  };
}
