// 输入框那枚型号选择器**列出哪几款**的纯逻辑（#1042）。
//
// 拎出来是因为这个菜单答错过一次，而答错的样子是安静的：`routeModel` 里托管
// **优先于**自带 key（ADR-0176 决定二），菜单却只按「配没配 key」筛厂商 —— 一个
// 付了钱、一把 key 都没配的用户打开它，一组都看不到，他能用的那几款界面上一个都不列。
// 本机三家 key 都配着，所以这个失败模式被完全掩盖（同 #1040 那一族的盲区）。
// 判据留在组件的 useMemo 里就没有保鲜期：它渲染不出错、只是少几行。
//
// 两组的分工是一句话：**上面那组不额外花钱，下面那些烧自己的 key**。所以网关供着的
// 型号从厂商组里摘掉、不并排出现两次 —— 同一个型号在两处点下去跑的是同一条路
// （托管优先），列两遍只会让人以为有得选。

import { AUTO_MODEL } from "../../../shared/autoModel.js";
import type { ModelChoice } from "../../../shared/modelCatalog.js";
import type { OllamaModelInfo } from "../../../shared/shellBridge.js";
import { describeModel, modelsByProvider, ollamaChoiceFrom } from "../../../shared/modelCatalog.js";
import { findProvider, type ProviderId } from "../../../shared/providerCatalog.js";

/** 菜单里的一项。`choice` 为 null = 网关供着但本仓目录里没有这一款，只有一个 id */
export interface ModelMenuItem {
  id: string;
  choice: ModelChoice | null;
  /** 画在左边那枚厂商字形；null = 这一格没有（Auto，或目录外的型号） */
  provider: ProviderId | null;
  /** 这一项是 Auto（渲染层据此换成中性方块） */
  auto?: true;
}

export interface ModelMenuGroup {
  key: string;
  /** 组头写什么；**`null` = 这一组不画组头**（#1058）。订阅那一组是唯一一组
      （#1051 之后两组不并存，ADR-0248 决策六），给唯一一组挂个标题就是噪音；
      厂商那几组照旧要写，那边是真的有好几组要分开 */
  heading: string | null;
  items: ModelMenuItem[];
}

export interface ModelMenuInput {
  /** 网关此刻供着哪几款，**从便宜到贵**（`billingView.hostedModels`）。
      空 = 没订阅 / 还没查到，整块退回改动前的样子（只列配了 key 的厂商） */
  hosted: readonly string[];
  /** 这个人是不是订阅用户（`billingView.isSubscribed`）。是 = **厂商那几组一个都不列**
      （#1051：订阅用户不许自带 key）。这不是「藏起来」——`routeModel` 那一侧同一时刻
      也不再给 direct，两边说同一句话；只藏界面的话，选着老型号的存量会话照旧会走到
      用户自己的 key 上 */
  subscribed: boolean;
  /** 这个入口允不允许选 Auto */
  allowAuto: boolean;
  /** 厂商 apiKeyEnv → 配没配（store 的 keyStatus） */
  keyStatus: Readonly<Record<string, string>>;
  /** 本机 Ollama 现问现拼进来的那几款 */
  ollamaModels: readonly OllamaModelInfo[];
  /** 此刻选中的型号 id。key 被清掉之后菜单里也得能找到它 */
  currentModel: string;
  /** 只列一部分型号（看图设置那格只列 supportsVision 的款） */
  filter?: ((m: ModelChoice) => boolean) | undefined;
}

/** Auto 至少要有两款可挑才成立：不到两款时 `pickAutoModel` 一律回 null，
    画出来就是一颗点了什么都不发生的钮（同 agentToolsForm「一台都不给」那条） */
export const AUTO_MIN_MODELS = 2;

export function modelMenuGroups(input: ModelMenuInput): ModelMenuGroup[] {
  const { hosted, allowAuto, subscribed, keyStatus, ollamaModels, currentModel, filter } = input;
  const keep = (m: ModelChoice) => (filter ? filter(m) : true);
  const ready = (id: ProviderId): boolean => {
    const info = findProvider(id);
    if (!info) return false;
    if (info.keyless) return true; // 本机 Ollama:能连上就能用
    return (keyStatus[info.apiKeyEnv] ?? "") !== "";
  };

  // ① 订阅那一组
  const subItems: ModelMenuItem[] = [];
  if (allowAuto && hosted.length >= AUTO_MIN_MODELS) {
    subItems.push({ id: AUTO_MODEL, choice: null, provider: null, auto: true });
  }
  for (const id of hosted) {
    const m = describeModel(id);
    if (m) {
      if (!keep(m)) continue;
      subItems.push({ id, choice: m, provider: m.provider });
      continue;
    }
    // 目录里没有的型号（网关上了新款而本仓目录还没跟上）：**没有 filter 时留着**
    // 并原样显示 id —— 藏起来就是「看不见却仍然供着」。给了 filter（比如只列看得见
    // 图的）就只能丢：那道筛子问的是一个我们此刻答不出的问题，答不出而放行，
    // 就是 #722 那个撒谎的勾
    if (filter === undefined) subItems.push({ id, choice: null, provider: null });
  }

  // ② 厂商那几组：自带 key 才跑得动的那些。**订阅用户这一段整个不出**（#1051）——
  // 连本机 Ollama 也不出：它不要 key、也不花钱，但留着它就等于留下一条「选单里有、
  // 路由却不通」的路（`routeModel` 那边订阅这一侧只剩 hosted / blocked）。
  //
  // 于是两组**从不并存**：订阅了只有上面那组，没订阅只有下面这些（没订阅时
  // `hostedModels` 回空，上面那组自然也不出）。#1042 当初为并存写的那道「订阅供的
  // 从厂商组里摘掉」的去重因此没了消费方，一并删掉——留着一段跑不到的代码，
  // 下一个人会以为它还在保护什么。
  if (subscribed) {
    return subItems.length > 0 ? [{ key: HOSTED_GROUP_KEY, heading: null, items: subItems }] : [];
  }

  // Ollama 的型号不在目录里（本机装了什么只有本机知道），现问现拼进来。
  // 只留会调工具的：这个 agent 的每一步都是工具调用，选一个不会调工具的型号
  // 等于选了一个只会聊天的搭档 —— 与其让它在会话里静默地什么也不做，
  // 不如现在就不出现在选单里（设置页会列出它并说明为什么被藏起来）。
  // 一个都没有就整组不出现：空的二级菜单比没有这一项更让人困惑
  const usable = ollamaModels.filter((m) => m.tools);
  const ollama =
    usable.length > 0
      ? [{ provider: "ollama" as ProviderId, models: usable.map(ollamaChoiceFrom) }]
      : [];
  const rest: ModelMenuGroup[] = [];
  for (const g of [...modelsByProvider(), ...ollama]) {
    const all = g.models.filter(keep);
    // 没配 key 的厂商压根不进这个菜单：这里是「挑一个现在就能跑的型号」，
    // 十来行点进去只会撞上「需要 key」的死路。配 key 是另一件事，走底下那个入口。
    // 例外挂在**当前选中的那一款**上，不挂在它那一家上——key 被清掉之后菜单里
    // 也得能找到它（否则触发器显示着一个在菜单里不存在的型号），但只留它一个：
    // 按「那一家」放行会顺带把同厂另外几款没 key 也没托管的型号一起摆出来，
    // 那正是上一句要避免的死路
    const models = ready(g.provider) ? all : all.filter((m) => m.model === currentModel);
    if (models.length === 0) continue;
    const info = findProvider(g.provider);
    if (!info) continue;
    rest.push({
      key: g.provider,
      heading: info.name,
      items: models.map((m) => ({ id: m.model, choice: m, provider: g.provider })),
    });
  }

  return rest;
}

export const HOSTED_GROUP_KEY = "__hosted__";
