// Excel 公式的小号求值器（#1683）。exceljs 只写公式不算结果，而手机上的预览（iOS 快速查看、安卓的文件预览）
// 读的是文件里存的「上次算出来的值」——不存的话，一张账单的合计那一格在手机上是空的。于是常用的那几个
// 我们自己算一遍、连公式一起写进去（Excel 打开时照样会重算）。
//
// 认：数字、同一张表里的 A1 / A1:B9、+ - * / ^、括号、一元负号，函数 SUM / AVERAGE / MIN / MAX / COUNT / ROUND /
// ABS / IF（比较 = <> < > <= >=）。别的（跨表引用、文本函数、日期函数）算不出就回 null：只写公式不写结果，
// 不猜一个数——宁可空着，不填错的。纯函数。

export type CellValue = string | number | boolean | null;

/** "B12" → [行下标, 列下标]（都从 0 起） */
export function parseRef(ref: string): [number, number] | null {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,6})$/.exec(ref.toUpperCase());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [Number(m[2]) - 1, col - 1];
}

export function colName(c: number): string {
  let s = "";
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

type Tok = { t: "num"; v: number } | { t: "ref"; v: string } | { t: "range"; a: string; b: string } | { t: "fn"; v: string } | { t: "op"; v: string } | { t: "str"; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^\d+(\.\d+)?%?/.exec(src.slice(i));
    if (num) {
      const raw = num[0];
      out.push({ t: "num", v: raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw) });
      i += raw.length;
      continue;
    }
    const range = /^\$?[A-Za-z]{1,3}\$?\d{1,6}:\$?[A-Za-z]{1,3}\$?\d{1,6}/.exec(src.slice(i));
    if (range) {
      const [a, b] = range[0].split(":");
      out.push({ t: "range", a: a!, b: b! });
      i += range[0].length;
      continue;
    }
    const fn = /^[A-Za-z]+(?=\s*\()/.exec(src.slice(i));
    if (fn) { out.push({ t: "fn", v: fn[0].toUpperCase() }); i += fn[0].length; continue; }
    const ref = /^\$?[A-Za-z]{1,3}\$?\d{1,6}/.exec(src.slice(i));
    if (ref) { out.push({ t: "ref", v: ref[0] }); i += ref[0].length; continue; }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end < 0) return null;
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const op = /^(<=|>=|<>|[-+*/^(),=<>])/.exec(src.slice(i));
    if (op) { out.push({ t: "op", v: op[0] }); i += op[0].length; continue; }
    return null;
  }
  return out;
}

type Val = number | string | boolean | number[];

export function evaluateFormula(formula: string, cell: (r: number, c: number) => Val | null): number | string | boolean | null {
  const toks = tokenize(formula.replace(/^=/, ""));
  if (toks === null) return null;
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const eat = (v: string): boolean => {
    const t = toks[p];
    if (t && t.t === "op" && t.v === v) { p++; return true; }
    return false;
  };
  const fail = (): never => { throw new Error("bad"); };
  const num = (v: Val | null): number => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v === null || v === "") return 0;
    if (Array.isArray(v)) return v.reduce((a, x) => a + x, 0);
    const n = Number(v);
    return Number.isFinite(n) ? n : fail();
  };
  const rangeVals = (a: string, b: string): number[] => {
    const ra = parseRef(a); const rb = parseRef(b);
    if (!ra || !rb) return fail();
    const out: number[] = [];
    for (let r = Math.min(ra[0], rb[0]); r <= Math.max(ra[0], rb[0]); r++) {
      for (let c = Math.min(ra[1], rb[1]); c <= Math.max(ra[1], rb[1]); c++) {
        const v = cell(r, c);
        if (typeof v === "number") out.push(v);
        else if (Array.isArray(v)) out.push(...v);
      }
    }
    return out;
  };
  const args = (): Val[] => {
    const xs: Val[] = [];
    if (eat(")")) return xs;
    for (;;) {
      const t = peek();
      if (t && t.t === "range") { p++; xs.push(rangeVals(t.a, t.b)); }
      else xs.push(cmp());
      if (eat(")")) return xs;
      if (!eat(",")) return fail();
    }
  };
  const flat = (xs: Val[]): number[] => xs.flatMap((x) => (Array.isArray(x) ? x : [num(x)]));
  const call = (name: string): Val => {
    if (!eat("(")) return fail();
    const xs = args();
    switch (name) {
      case "SUM": return flat(xs).reduce((a, x) => a + x, 0);
      case "AVERAGE": case "AVG": { const f = flat(xs); return f.length === 0 ? fail() : f.reduce((a, x) => a + x, 0) / f.length; }
      case "MIN": { const f = flat(xs); return f.length === 0 ? 0 : Math.min(...f); }
      case "MAX": { const f = flat(xs); return f.length === 0 ? 0 : Math.max(...f); }
      case "COUNT": return flat(xs).length;
      case "ABS": return Math.abs(num(xs[0] ?? 0));
      case "ROUND": { const k = 10 ** num(xs[1] ?? 0); return Math.round(num(xs[0] ?? 0) * k) / k; }
      case "IF": return (typeof xs[0] === "boolean" ? xs[0] : num(xs[0] ?? 0) !== 0) ? (xs[1] ?? true) : (xs[2] ?? false);
      default: return fail();
    }
  };
  const atom = (): Val => {
    const t = peek();
    if (!t) return fail();
    if (eat("(")) { const v = cmp(); if (!eat(")")) fail(); return v; }
    if (eat("-")) return -num(atom());
    if (eat("+")) return num(atom());
    p++;
    if (t.t === "num") return t.v;
    if (t.t === "str") return t.v;
    if (t.t === "ref") { const rc = parseRef(t.v); if (!rc) return fail(); const v = cell(rc[0], rc[1]); return v === null ? 0 : v; }
    if (t.t === "fn") return call(t.v);
    return fail();
  };
  const pow = (): Val => { let v = atom(); while (eat("^")) v = num(v) ** num(atom()); return v; };
  const mul = (): Val => {
    let v = pow();
    for (;;) {
      if (eat("*")) v = num(v) * num(pow());
      else if (eat("/")) { const d = num(pow()); if (d === 0) return fail(); v = num(v) / d; }
      else return v;
    }
  };
  const add = (): Val => {
    let v = mul();
    for (;;) {
      if (eat("+")) v = num(v) + num(mul());
      else if (eat("-")) v = num(v) - num(mul());
      else return v;
    }
  };
  const cmp = (): Val => {
    const a = add();
    for (const op of ["<=", ">=", "<>", "=", "<", ">"]) {
      if (eat(op)) {
        const b = add();
        const x = typeof a === "string" || typeof b === "string" ? String(a) : num(a);
        const y = typeof a === "string" || typeof b === "string" ? String(b) : num(b);
        return op === "=" ? x === y : op === "<>" ? x !== y : op === "<" ? x < y : op === ">" ? x > y : op === "<=" ? x <= y : x >= y;
      }
    }
    return a;
  };
  try {
    const v = cmp();
    if (p !== toks.length) return null;
    if (Array.isArray(v)) return null;
    if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e10) / 1e10 : null;
    return v;
  } catch {
    return null;
  }
}

/** 整张表：公式格（以 = 开头的字符串）逐个算，引用到别的公式格时递归（成环 = 算不出） */
export function evaluateSheet(rows: readonly (readonly CellValue[])[]): Map<string, number | string | boolean> {
  const results = new Map<string, number | string | boolean>();
  const visiting = new Set<string>();
  const valueAt = (r: number, c: number): Val | null => {
    const raw = rows[r]?.[c];
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "string" && raw.startsWith("=")) {
      const key = `${r},${c}`;
      if (results.has(key)) return results.get(key)!;
      if (visiting.has(key)) throw new Error("cycle");
      visiting.add(key);
      const v = evaluateFormula(raw, valueAt);
      visiting.delete(key);
      if (v === null) throw new Error("unknown");
      results.set(key, v);
      return v;
    }
    return raw;
  };
  rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (typeof v === "string" && v.startsWith("=") && !results.has(`${r},${c}`)) {
        try { valueAt(r, c); } catch { /* 算不出：只写公式 */ }
      }
    })
  );
  return results;
}
