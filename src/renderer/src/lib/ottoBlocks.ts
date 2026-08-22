// 模型自己产出的结构化块 —— ```otto-spec / otto-compare / otto-score / otto-flow
// 里那一段 JSON 的解析与校验。
//
// 为什么走围栏而不是新事件类型:块的内容是模型正文的一部分,它本来就落在
// assistant_message.content 里。另起一种事件等于让同一句话有两个落盘位置,
// 而且旧日志重放时会缺这一半。围栏 = 零 schema 变更、旧日志照样重放
// (老会话里没有这种块,渲染出来就是普通代码块)。
//
// 校验必须严:这些字段直接喂给展示元件,一个 undefined 就是一处崩溃,
// 而它是模型写的 —— 模型写错是常态,不是异常。所有 parse 失败(JSON 语法错、
// 字段缺、类型不对)一律返回 null,调用方退回普通代码块把原文照原样显示出来。
// 宁可给人看一段 JSON,也不能吞掉模型说的话,更不能白屏。

import type { ComparisonOption } from "@/components/elements/comparison-card.js";
import type { JobStage } from "@/components/elements/job-progress.js";
import type { FlowEdge, FlowNode, FlowNodeState } from "@/components/elements/flow-graph.js";
import type { ScoreCriterion } from "@/components/elements/score-breakdown.js";
import type { SpecRow } from "@/components/elements/spec-sheet.js";
import type { TimelineEvent, TimelineWhen } from "@/components/elements/timeline.js";

/** 围栏语言 → 块类型。语言前缀统一带 otto-,免得和真的代码语言撞名 */
export const BLOCK_LANGUAGES = [
  "otto-spec",
  "otto-compare",
  "otto-score",
  "otto-flow",
  "otto-timeline",
  "otto-job",
] as const;
export type BlockLanguage = (typeof BLOCK_LANGUAGES)[number];

// ── 一组小检查器。写成函数而不是塞一个 schema 库:要校验的只有四种形状,
//    引一个库的体积和这四十行不成比例
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";
/** 有限数。JSON 里没有 NaN/Infinity,但 1e999 会解析成 Infinity,进了元件就是布局炸掉 */
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const bool = (v: unknown): v is boolean => typeof v === "boolean";

/** 数组且每一项都过检。空数组一律不收:一张没有任何行的卡等于一个空框 */
function items<T>(v: unknown, ok: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: T[] = [];
  for (const raw of v) {
    const one = ok(raw);
    if (one === null) return null;
    out.push(one);
  }
  return out;
}

// ── 四种块 ────────────────────────────────────────────────────────

export interface SpecBlock {
  title: string;
  subtitle?: string;
  rows: SpecRow[];
}

export interface CompareBlock {
  traitLabels: string[];
  options: ComparisonOption[];
  recommendedId: string;
  reason: string;
}

export interface ScoreBlock {
  verdict: string;
  total: number;
  outOf: number;
  criteria: ScoreCriterion[];
}

export interface FlowBlock {
  nodes: FlowNode[];
  edges: FlowEdge[];
}

const FLOW_STATES: readonly FlowNodeState[] = ["done", "active", "pending"];
const WHENS: readonly TimelineWhen[] = ["past", "now", "future"];

export interface TimelineBlock {
  events: TimelineEvent[];
}

/** 进度块。这张卡报的是**模型自己声明的**进度:它不是运行时探到的真值,
    也不会自己往前走 —— 一条消息落盘之后就定格在那一刻。所以没有 onCancel:
    没有任何东西可以被取消 */
export interface JobBlock {
  title: string;
  stages: JobStage[];
  stageIndex: number;
  stageProgress: number;
  eta: string;
}

function specRow(v: unknown): SpecRow | null {
  if (!isObj(v) || !str(v["label"]) || !str(v["value"])) return null;
  const emphasis = v["emphasis"];
  if (emphasis !== undefined && !bool(emphasis)) return null;
  return { label: v["label"], value: v["value"], ...(emphasis === true ? { emphasis: true } : {}) };
}

function spec(v: Record<string, unknown>): SpecBlock | null {
  if (!str(v["title"])) return null;
  const subtitle = v["subtitle"];
  if (subtitle !== undefined && !str(subtitle)) return null;
  const rows = items(v["rows"], specRow);
  if (rows === null) return null;
  return { title: v["title"], ...(str(subtitle) ? { subtitle } : {}), rows };
}

/** 一格特性:字符串 = 写这句话,false = 没有这一项。JSON 里没有 undefined,
    所以"没有"只能用 false 表达（元件本来就这么设计的） */
function trait(v: unknown): string | false | null {
  if (str(v)) return v;
  return v === false ? false : null;
}

function option(v: unknown): ComparisonOption | null {
  if (!isObj(v) || !str(v["id"]) || !str(v["name"]) || !str(v["headline"])) return null;
  const traits = items(v["traits"], (t) => {
    const one = trait(t);
    // trait 的合法值包含 false,不能用 null 之外的东西当"不合法"——
    // 这里把它包一层再拆，免得 false 被 items 当成失败
    return one === null ? null : ({ v: one } as { v: string | false });
  });
  if (traits === null) return null;
  return {
    id: v["id"],
    name: v["name"],
    headline: v["headline"],
    traits: traits.map((t) => t.v),
  };
}

function compare(v: Record<string, unknown>): CompareBlock | null {
  const traitLabels = items(v["traitLabels"], (x) => (str(x) ? x : null));
  const options = items(v["options"], option);
  if (traitLabels === null || options === null) return null;
  if (!str(v["recommendedId"]) || !str(v["reason"])) return null;
  // 推荐的那一项必须真的在选项里,否则整张卡没有任何一栏会被标成推荐,
  // 而底下还写着"推荐它,因为…"—— 自相矛盾比不显示更坏
  if (!options.some((o) => o.id === v["recommendedId"])) return null;
  return { traitLabels, options, recommendedId: v["recommendedId"], reason: v["reason"] };
}

function criterion(v: unknown): ScoreCriterion | null {
  if (!isObj(v) || !str(v["label"]) || !num(v["score"]) || !num(v["weight"])) return null;
  const note = v["note"];
  if (note !== undefined && !str(note)) return null;
  return {
    label: v["label"],
    score: v["score"],
    weight: v["weight"],
    ...(str(note) ? { note } : {}),
  };
}

function score(v: Record<string, unknown>): ScoreBlock | null {
  if (!str(v["verdict"]) || !num(v["total"]) || !num(v["outOf"])) return null;
  // 满分 0 分不出比例,元件会画一条永远空的条
  if (v["outOf"] <= 0) return null;
  const criteria = items(v["criteria"], criterion);
  if (criteria === null) return null;
  return { verdict: v["verdict"], total: v["total"], outOf: v["outOf"], criteria };
}

function node(v: unknown): FlowNode | null {
  if (!isObj(v) || !str(v["id"]) || !str(v["label"])) return null;
  const { column, row, state } = v;
  // 坐标必须是非负整数:元件按格子算像素,-1 或 0.5 会把节点画到卡外面
  if (!num(column) || !num(row) || !Number.isInteger(column) || !Number.isInteger(row)) return null;
  if (column < 0 || row < 0) return null;
  if (!str(state) || !FLOW_STATES.includes(state as FlowNodeState)) return null;
  return { id: v["id"], label: v["label"], column, row, state: state as FlowNodeState };
}

function flow(v: Record<string, unknown>): FlowBlock | null {
  const nodes = items(v["nodes"], node);
  if (nodes === null) return null;
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) return null; // 同名节点 = 连线指向谁说不清
  // 边可以一条都没有(单列的几个步骤),所以不走 items 那条"空数组不收"的规矩
  const rawEdges = v["edges"];
  if (rawEdges !== undefined && !Array.isArray(rawEdges)) return null;
  const edges: FlowEdge[] = [];
  for (const e of rawEdges ?? []) {
    if (!isObj(e) || !str(e["from"]) || !str(e["to"])) return null;
    // 指向不存在的节点:元件会去查一个 undefined 的坐标
    if (!ids.has(e["from"]) || !ids.has(e["to"])) return null;
    edges.push({ from: e["from"], to: e["to"] });
  }
  return { nodes, edges };
}

function timelineEvent(v: unknown): TimelineEvent | null {
  if (!isObj(v) || !str(v["id"]) || !str(v["time"]) || !str(v["title"])) return null;
  const when = v["when"];
  if (!str(when) || !WHENS.includes(when as TimelineWhen)) return null;
  const detail = v["detail"];
  if (detail !== undefined && !str(detail)) return null;
  return {
    id: v["id"],
    when: when as TimelineWhen,
    time: v["time"],
    title: v["title"],
    ...(str(detail) ? { detail } : {}),
  };
}

function timeline(v: Record<string, unknown>): TimelineBlock | null {
  const events = items(v["events"], timelineEvent);
  if (events === null) return null;
  if (new Set(events.map((e) => e.id)).size !== events.length) return null; // id 是 React key
  return { events };
}

function stage(v: unknown): JobStage | null {
  if (!isObj(v) || !str(v["name"]) || !num(v["weight"])) return null;
  // 权重是分母的一部分,负数或 0 会把整条进度条算歪(全 0 时元件退化成 1)
  if (v["weight"] <= 0) return null;
  return { name: v["name"], weight: v["weight"] };
}

function job(v: Record<string, unknown>): JobBlock | null {
  if (!str(v["title"]) || !str(v["eta"])) return null;
  const stages = items(v["stages"], stage);
  if (stages === null) return null;
  // 阶段名是元件的 React key,重名会画丢一格
  if (new Set(stages.map((s) => s.name)).size !== stages.length) return null;
  const { stageIndex, stageProgress } = v;
  if (!num(stageIndex) || !Number.isInteger(stageIndex) || stageIndex < 0) return null;
  // 越界就是"全做完了"这一档,元件自己认(stage >= stages.length),不必拒
  if (!num(stageProgress) || stageProgress < 0 || stageProgress > 1) return null;
  return { title: v["title"], stages, stageIndex, stageProgress, eta: v["eta"] };
}

// ── 出口 ──────────────────────────────────────────────────────────

export type OttoBlock =
  | { kind: "otto-spec"; data: SpecBlock }
  | { kind: "otto-compare"; data: CompareBlock }
  | { kind: "otto-score"; data: ScoreBlock }
  | { kind: "otto-flow"; data: FlowBlock }
  | { kind: "otto-timeline"; data: TimelineBlock }
  | { kind: "otto-job"; data: JobBlock };

export function isBlockLanguage(language: string): language is BlockLanguage {
  return (BLOCK_LANGUAGES as readonly string[]).includes(language);
}

/** 严格 JSON 解不开时再放宽一档:给裸键名补双引号、去掉尾逗号。
    提示词里的字段写法 `{title, rows:[…]}` 长得像 JS,模型照着写成对象字面量
    是常见的走样 —— 一张本来能画出来的卡因为键名少两个引号退回成裸代码,
    不值。不用正则而是逐字扫:字符串内部原样跳过,`{`/`,` 后面紧跟的
    `标识符:` 才补引号,所以 value 里出现 "a, b: c" 不会被误伤。
    解不开返回 undefined(null 是合法 JSON 值,不能拿来当"失败") */
function parseLenient(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch {
    /* 走下面那条 */
  }
  try {
    return JSON.parse(relaxJson(source));
  } catch {
    return undefined;
  }
}

function relaxJson(src: string): string {
  let out = "";
  let i = 0;
  // 上一个非空白的结构字符是不是 { 或 , —— 只有这时后面的标识符才可能是键名
  let keyPos = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"') {
      // 整段字符串原样搬过去(含转义)
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      keyPos = false;
      continue;
    }
    if (ch === "," ) {
      // 尾逗号:后面只剩空白 + } 或 ] 的话整个丢掉
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j]!)) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
      out += ch;
      i++;
      keyPos = true;
      continue;
    }
    if (ch === "{") {
      out += ch;
      i++;
      keyPos = true;
      continue;
    }
    if (keyPos && /[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < src.length && /[\w$]/.test(src[j]!)) j++;
      let k = j;
      while (k < src.length && /\s/.test(src[k]!)) k++;
      if (src[k] === ":") {
        out += `"${src.slice(i, j)}"`;
        i = j;
        keyPos = false;
        continue;
      }
    }
    if (!/\s/.test(ch)) keyPos = false;
    out += ch;
    i++;
  }
  return out;
}

/** 一段围栏正文 → 块;认不出来一律 null(调用方退回普通代码块) */
export function parseBlock(language: string, source: string): OttoBlock | null {
  if (!isBlockLanguage(language)) return null;
  const raw = parseLenient(source);
  if (raw === undefined) return null; // 还在流的半段 JSON 也走这条路——写完了自然就解析得开
  if (!isObj(raw)) return null;
  switch (language) {
    case "otto-spec": {
      const data = spec(raw);
      return data === null ? null : { kind: "otto-spec", data };
    }
    case "otto-compare": {
      const data = compare(raw);
      return data === null ? null : { kind: "otto-compare", data };
    }
    case "otto-score": {
      const data = score(raw);
      return data === null ? null : { kind: "otto-score", data };
    }
    case "otto-flow": {
      const data = flow(raw);
      return data === null ? null : { kind: "otto-flow", data };
    }
    case "otto-timeline": {
      const data = timeline(raw);
      return data === null ? null : { kind: "otto-timeline", data };
    }
    case "otto-job": {
      const data = job(raw);
      return data === null ? null : { kind: "otto-job", data };
    }
  }
}
