// 自动压缩设置栏目——开关 + 阈值滑块。落盘走 window.otter.getAutoCompact /
// setAutoCompact（shellBridge），逻辑判定在 shared/autoCompact.ts（引擎和这里
// 同一把尺子，见该文件顶部注释）。
//
// 保存节奏：开关一点就落盘（低频、离散动作，即时反馈更要紧）；滑块拖动中
// 高频触发 onChange，去抖 200ms 再落盘——不然拖一下打一次 IPC，主进程写盘写到抽筋。

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Slider } from "@/components/ui/slider.js";
import { Switch } from "@/components/ui/switch.js";
import { HEADER, HINT, MAIN_COL, SETTINGS_BODY, SettingsTitle } from "../settingsShell.js";
import { SidebarNub } from "./SidebarNub.js";
import { bridgeErrorMessage } from "../lib/bridgeError.js";
import { MICRO_COMPACT_HINT, describeThreshold } from "../lib/autoCompactCopy.js";
import { useChat } from "../store.js";
import { useModelChoice } from "../lib/useModelChoice.js";
import {
  DEFAULT_AUTO_COMPACT,
  THRESHOLD_MAX,
  THRESHOLD_MIN,
  defaultThreshold,
  type AutoCompactSettings as AutoCompactSettingsValue,
} from "../../../shared/autoCompact.js";

/** 去抖间隔：拖滑块时落盘的节奏，同 App.tsx 里其它去抖写盘的量级 */
const THRESHOLD_DEBOUNCE_MS = 200;

export function AutoCompactSettings() {
  const model = useChat((s) => s.model);
  // 主进程判定要不要自动压缩，用的就是 current.contextWindowKnown（agent.ts）——
  // 这里也走 useModelChoice（describeModelWith，含本机 Ollama 探测），窗口未知时
  // 显式取 undefined，不能让引擎当"没窗口"而设置页却煞有介事地显示一个兜底猜测
  const modelInfo = useModelChoice(model);
  const contextWindow = modelInfo?.contextWindowKnown ? modelInfo.contextWindow : undefined;

  // null = 还没从主进程读到（禁用状态，同 MemorySettings 的 loaded 模式）
  const [loaded, setLoaded] = useState<AutoCompactSettingsValue | null>(null);
  const [settings, setSettings] = useState<AutoCompactSettingsValue>(DEFAULT_AUTO_COMPACT);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.otter
      .getAutoCompact()
      .then((s) => {
        if (cancelled) return;
        setLoaded(s);
        setSettings(s);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(bridgeErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载时别让一个悬空的去抖定时器在设置页关掉之后还落盘
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const persist = (next: AutoCompactSettingsValue) => {
    setError(null);
    window.otter.setAutoCompact(next).catch((e: unknown) => setError(bridgeErrorMessage(e)));
  };

  const onEnabledChange = (enabled: boolean) => {
    // 先取消滑块那边悬着的去抖：它捕获的 next 是切换开关之前的 settings 快照，
    // 200ms 后原样落盘会把这里刚写的 enabled 静默盖回去（拖了滑块又立刻点了开关
    // 才会撞上，但撞上就是脏写，不吱声）
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const next = { ...settings, enabled };
    setSettings(next);
    persist(next); // 开关是低频离散动作，即时落盘
  };

  const onMicroChange = (micro: boolean) => {
    // 同 onEnabledChange：先掐掉滑块那边悬着的去抖，别让旧快照把 micro 盖回去
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // exactOptionalPropertyTypes：关 = 键消失，不是 micro:false
    const { micro: _drop, ...rest } = settings;
    const next: AutoCompactSettingsValue = micro ? { ...rest, micro: true } : rest;
    setSettings(next);
    persist(next);
  };

  const onThresholdChange = (values: number[]) => {
    const threshold = values[0];
    if (threshold === undefined) return;
    const next = { ...settings, threshold };
    setSettings(next); // 界面立刻跟手，落盘去抖
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => persist(next), THRESHOLD_DEBOUNCE_MS);
  };

  const restoreDefault = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // exactOptionalPropertyTypes:"清空覆盖"是整个键消失，不是赋成 undefined ——
    // AutoCompactSettings.threshold 的类型不接受显式 undefined。
    // 用剩余展开而不是重建 { enabled }：这个按钮只清阈值，重建会把 micro 一起吞掉
    const { threshold: _drop, ...next } = settings;
    setSettings(next);
    persist(next);
  };

  const disabled = loaded === null;
  // 滑块把手需要一个具体数字才能画——没覆盖过就先按当前型号的默认档显示，
  // 这不是"已经落盘的覆盖值"，纯粹是把手该停在哪
  const sliderValue = settings.threshold ?? defaultThreshold(contextWindow ?? 0);
  const modelLabel = modelInfo?.label ?? model;

  return (
    <div className={MAIN_COL}>
      <header className={HEADER}>
        <SidebarNub />
        <SettingsTitle id="context" className="flex-1" />
      </header>
      <section className={SETTINGS_BODY}>
        <p className={HINT}>
          上下文用量接近型号窗口上限时，自动摘要折叠此前对话，腾出空间接着聊——
          和手动 <span className="font-mono text-foreground/80">/compact</span> 是同一套逻辑，只是自己找时机触发。
        </p>
        <div className="flex flex-col gap-4 rounded-[10px] border border-border px-[14px] py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">自动压缩上下文</span>
              <p className={HINT}>关掉之后只能手动 /compact，上下文超了也不会自己压</p>
            </div>
            <Switch checked={settings.enabled} onCheckedChange={onEnabledChange} disabled={disabled} />
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] font-medium">压缩阈值</span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs active:scale-[0.97]"
                disabled={disabled || !settings.enabled || settings.threshold === undefined}
                onClick={restoreDefault}
              >
                恢复默认
              </Button>
            </div>
            <Slider
              value={[sliderValue]}
              min={THRESHOLD_MIN}
              max={THRESHOLD_MAX}
              step={0.05}
              disabled={disabled || !settings.enabled}
              onValueChange={onThresholdChange}
            />
            <p className={HINT}>默认：窗口 ≥512K 时 50%，否则 75%</p>
            <p className={HINT}>
              当前型号（{modelLabel}）：{describeThreshold(settings, contextWindow)}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">微压缩</span>
              <p className={HINT}>每轮收口后把最老的一段对话并进摘要，用户原话保留。</p>
              <p className={HINT}>{MICRO_COMPACT_HINT}</p>
              <p className={HINT}>和分区分类用同一个便宜模型，需要配好它的 key；没配就静默不跑。</p>
            </div>
            <Switch checked={settings.micro === true} onCheckedChange={onMicroChange} disabled={disabled} />
          </div>
        </div>
        {error !== null && <p className="text-destructive text-[13px]">{error}</p>}
      </section>
    </div>
  );
}
