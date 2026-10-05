// 一段文字用的是哪种文字（#1683）：PDF 要按字挑字体（Helvetica 只认西欧字母，中文、日文、韩文、泰文、天城文
// 各要各的字体文件），Word / PPT 要给一个「东亚字体」提示。纯函数。

export type Script = "latin" | "cjk" | "thai" | "deva";
/** 中日韩里具体哪一种：同一个汉字在三套字体里字形不同（「直」「骨」），日文文档用简中字体印出来是错字形 */
export type CjkVariant = "sc" | "tc" | "jp" | "kr";

export function scriptOf(ch: string): Script {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x0e00 && c <= 0x0e7f) return "thai";
  if (c >= 0x0900 && c <= 0x097f) return "deva";
  if (
    (c >= 0x1100 && c <= 0x11ff) || // 韩文字母
    (c >= 0x2e80 && c <= 0x2fdf) || // 部首
    (c >= 0x3000 && c <= 0x30ff) || // 中日标点、假名
    (c >= 0x3100 && c <= 0x31ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa960 && c <= 0xa97f) ||
    (c >= 0xac00 && c <= 0xd7ff) || // 韩文音节
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xffef) || // 全角
    (c >= 0x20000 && c <= 0x2ffff)
  ) {
    return "cjk";
  }
  return "latin";
}

/** 按文字切段：相邻同一种文字的字并成一段。空白与标点跟着前一段走（不让一个空格自成一段换字体） */
export function splitByScript(text: string): { script: Script; text: string }[] {
  const out: { script: Script; text: string }[] = [];
  for (const ch of text) {
    const neutral = /[\s\d.,:;!?'"()\-–—/%+=*&#@$€£¥]/.test(ch);
    const s = scriptOf(ch);
    const last = out[out.length - 1];
    if (last !== undefined && (last.script === s || (neutral && s === "latin"))) {
      last.text += ch;
    } else {
      out.push({ script: s, text: ch });
    }
  }
  return out;
}

/** 整份文档里出现了哪几种文字 */
export function scriptsIn(text: string): Set<Script> {
  const s = new Set<Script>();
  for (const ch of text) s.add(scriptOf(ch));
  return s;
}

/** 中日韩的哪一种：有假名 = 日文；有韩文 = 韩文；繁体常用字多于简体 = 繁中；否则简中 */
export function cjkVariantOf(text: string): CjkVariant {
  if (/[぀-ヿ]/.test(text)) return "jp";
  if (/[가-힯ᄀ-ᇿ]/.test(text)) return "kr";
  const trad = (text.match(/[們這說會個來對時過還為與們點後問們學國見關]/g) ?? []).length;
  const simp = (text.match(/[们这说会个来对时过还为与点后问学国见关]/g) ?? []).length;
  return trad > simp ? "tc" : "sc";
}

/** Word / PPT 的字体名（看文件的那台设备没有这款时会自己替换，所以这里只是提示） */
export function officeFontFor(text: string): { latin: string; eastAsia?: string } {
  const scripts = scriptsIn(text);
  if (scripts.has("cjk")) {
    const v = cjkVariantOf(text);
    const ea = v === "jp" ? "Yu Gothic" : v === "kr" ? "Malgun Gothic" : v === "tc" ? "Microsoft JhengHei" : "Microsoft YaHei";
    return { latin: "Calibri", eastAsia: ea };
  }
  if (scripts.has("thai")) return { latin: "Leelawadee UI" };
  if (scripts.has("deva")) return { latin: "Nirmala UI" };
  return { latin: "Calibri" };
}
