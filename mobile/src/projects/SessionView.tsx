// 会话详情：时间线 + 就地审批 + 回一条话。从 App.tsx 原样拆出来（#1237 M0），逻辑一个字没动。

import { useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS, ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import type { IslandAgent } from "../../../src/shared/shellBridge.js";
import type { MobileMessage } from "../../../src/shared/remote/frames.js";
import { UPLOAD_LIMITS } from "../../../src/shared/remote/uploads.js";
import { parseMarkdown, type Span as MdSpan } from "../../../src/shared/remote/markdown.js";
import { groupTimeline, splitTool } from "../../../src/shared/remote/timeline.js";
import {
  MAX_MB, NeedsRebuild, pickFiles, pickPhotos, takePhoto, tooBig, type Picked,
} from "../attach.js";
import { usePalette, type as t, MONO, radius, space } from "../theme.js";
import {
  Button, Card, DetailBar, Dot, Headline, Hint, Meta, Note, Spinner, StatusLine, Tile, useKeyboardInset,
} from "../ui.js";
import { elapsed } from "./clock.js";
import { hapticSent } from "../haptics.js";

/* ── 会话详情 ───────────────────────────────────────────
   点进来看时间线 + 就地审批。三件事值得说清楚:

   1. **待批那一块钉在底部**,不跟着时间线滚。审批是这一屏唯一的动作,
      而它在日志里的位置可能在几十条之上 —— 让人为了按一下先滚半天是坏的。
   2. **时间线只有三种角色**,而且已经在桌面那侧截过了(shared/remote/timeline.ts)。
      这里不再截,只把 truncated 标记翻译成一句"在电脑上看全文"。
   3. **新消息到了自动滚到底**,但只在人本来就贴着底的时候 —— 正在往回翻的人
      被拽回底部比不自动滚更烦。 */
export function SessionView({
  agent: a, now, messages, diag, online, notice, onDismissNotice,
  onBack, onDecide, onSubmit, onRetry,
}: {
  agent: IslandAgent;
  now: number;
  messages: MobileMessage[] | null;
  /** 连接活着没有。断了这一屏**不清空**——留着断线前的内容,顶上挂一条横幅
      说清楚它是旧的,同时把审批和发送都锁上 */
  online: boolean;
  diag: { frames: number; timelines: number; log: string[] };
  /** 桌面回过来的一句话,通常是"这个附件没收下"加理由 */
  notice: string | null;
  onDismissNotice: () => void;
  onBack: () => void;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  /** 回 null = 发出去了;回字符串 = 没发出去的理由 */
  onSubmit: (
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<string | null>;
  onRetry: () => void;
}) {
  const { c } = usePalette();
  const list = useRef<ScrollView | null>(null);
  const atBottom = useRef(true);
  /** 4 秒还没等到内容就别再转圈了。**一个永远转下去的菊花是最差的状态**:
      它和"这个会话是空的"、"帧被丢了"、"根本没连上"长得一模一样,
      而这三种情况用户该做的事完全不同 */
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    setWaited(false);
    const id = setTimeout(() => setWaited(true), 4_000);
    return () => clearTimeout(id);
  }, [a.sessionId, messages]);
  const tone = a.phase === "approval" ? "warn" : a.phase === "active" ? "busy" : "idle";
  const what = a.phase === "approval" ? "等你批" : a.phase === "active" ? "跑着" : "空闲";

  useEffect(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  }, [messages]);

  const { root, keyboard } = useKeyboardInset(() => {
    if (atBottom.current) list.current?.scrollToEnd({ animated: true });
  });

  return (
    // paddingBottom 让位给键盘。**这里不能用 KeyboardAvoidingView**——见 useKeyboardInset。
    // 之所以把内边距加在 flex:1 的外层而不是加在输入框上:外层的高度由父级定,
    // 内边距不改变它自己的 frame,所以量出来的位置在键盘开合期间是稳的(不会自激)
    <View
      ref={root.ref}
      onLayout={root.onLayout}
      style={{ flex: 1, paddingBottom: keyboard }}
    >
      <DetailBar
        back="项目" title={a.title ?? a.sessionId} onBack={onBack}
        right={<Dot tone={tone} />}
      />

      {online ? null : (
        <View style={{
          paddingHorizontal: space.md, paddingVertical: space.xs,
          borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border,
        }}>
          <StatusLine tone="warn">断开了 —— 下面是断线前的</StatusLine>
        </View>
      )}

      <ScrollView
        ref={list}
        style={{ flex: 1 }}
        // 往回翻就收键盘(iOS 的 interactive:跟着手指走,不是硬收);
        // 键盘还开着时点审批键要一次就中,所以 taps 不被键盘吃掉
        keyboardDismissMode={Platform.OS === "ios" ? "interactive" : "on-drag"}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.md, gap: space.sm, paddingBottom: space.lg }}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          // 24pt 的容差:滚动位置是浮点的,严格相等永远不成立
          atBottom.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 24;
        }}
        scrollEventThrottle={100}
      >
        <Meta>
          {what}
          {a.phase === "active" && a.turnStartedAt ? ` · ${elapsed(a.turnStartedAt, now)}` : ""}
          {a.currentTool ? ` · ${a.currentTool.verb} ${a.currentTool.target}` : ""}
        </Meta>
        {messages === null ? (
          waited ? (
            <Card style={{ gap: space.sm }}>
              <Headline>没等到时间线</Headline>
              <Hint>电脑那侧收到订阅了才会推。下面是这条连接说过的话:</Hint>
              <Meta>{`收到 ${diag.frames} 帧,其中时间线 ${diag.timelines} 条`}</Meta>
              {diag.log.map((line, i) => <Meta key={i}>{line}</Meta>)}
              <Button variant="outline" label="重新订阅" onPress={onRetry} />
            </Card>
          ) : (
            <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
              <Spinner />
            </View>
          )
        ) : messages.length === 0 ? (
          <Hint>这个会话还没有内容。</Hint>
        ) : (
          // 连续的工具调用先并成一组再画(shared/remote/timeline.ts)
          groupTimeline(messages).map((item) =>
            item.kind === "tools"
              ? <ToolGroup key={item.index} tools={item.tools} />
              : <Msg key={item.index} msg={item.message} />,
          )
        )}
      </ScrollView>

      {/* 审批在输入框上面:它是有时限的那个 */}
      <View>
        {a.pendingApproval ? (
          <View style={{
            padding: space.md,
            borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
            backgroundColor: c.background,
          }}>
            <Approval agent={a} onDecide={onDecide} online={online} />
          </View>
        ) : null}
        <Composer onSubmit={onSubmit} online={online}
          notice={notice} onDismissNotice={onDismissNotice} />
      </View>
    </View>
  );
}

/** 回一条消息,可以带附件。范围仍然到这里(ADR-0094):不建会话、不切模型 ——
    手机端是"看 + 审批"的第三个投影窗口,不是第二个完整客户端。
    附件是后加的一条(ADR-0112):手机上最常见的一句话就是"看看这张图"。

    发送键是个圆的、只有一个箭头,＋ 在左边 —— 和桌面输入区那两个同一个形状、
    同一个位置。多行输入里的回车是换行不是发送:手机上没有 Shift 可以按,
    把回车做成发送等于让人没法打第二段。

    **附件先传完,最后那条消息才带上它们的 id。** 反过来的话桌面会拿着一串
    还没到的 id,只能整条拒收。 */
function Composer({ onSubmit, online, notice, onDismissNotice }: {
  onSubmit: (
    text: string,
    files: readonly Picked[],
    onProgress: (done: number, total: number) => void,
  ) => Promise<string | null>;
  online: boolean;
  notice: string | null;
  onDismissNotice: () => void;
}) {
  const { c } = usePalette();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<readonly Picked[]>([]);
  const [err, setErr] = useState<string | null>(null);
  /** 传到第几片 / 一共几片。null = 没在传 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const busy = progress !== null;
  // 断线时输入框**不禁用**,只是发不出去:人可以照打,连接回来再按发送。
  // 禁用输入框会把已经打了一半的字连同光标一起抢走
  const ready = online && !busy && (text.trim().length > 0 || files.length > 0);

  const add = (picked: Picked[]): void => {
    // 这里只挡非图片:图片有缩放这条路,原图多大都先收下(见 attach.ts 的 tooBig)
    const big = picked.filter(tooBig);
    if (big.length) setErr(`${big.map((f) => f.name).join("、")} 超过 ${MAX_MB}MB,没加上`);
    const ok = picked.filter((f) => !tooBig(f));
    // 上限在这儿也挡一道:桌面那侧的重组器会拒,但让人选完了才被拒是坏的
    setFiles((prev) => [...prev, ...ok].slice(0, UPLOAD_LIMITS.maxPending));
  };

  const pick = (how: () => Promise<Picked[]>): void => {
    void (async () => {
      try {
        add(await how());
      } catch (e: unknown) {
        setErr(e instanceof NeedsRebuild ? e.message : e instanceof Error ? e.message : String(e));
      }
    })();
  };

  const openPicker = (): void => {
    setErr(null);
    const choices: { label: string; go: () => Promise<Picked[]> }[] = [
      { label: "照片", go: pickPhotos },
      { label: "拍照", go: takePhoto },
      { label: "文件", go: pickFiles },
    ];
    if (Platform.OS !== "ios") return pick(choices[0]!.go);
    ActionSheetIOS.showActionSheetWithOptions(
      { options: [...choices.map((x) => x.label), "取消"], cancelButtonIndex: choices.length },
      (i) => { if (i < choices.length) pick(choices[i]!.go); },
    );
  };

  const submit = (): void => {
    const t2 = text.trim();
    if (!t2 && files.length === 0) return;
    setErr(null);
    onDismissNotice();
    setProgress({ done: 0, total: 0 });
    void (async () => {
      try {
        const why = await onSubmit(t2, files, (done, total) => setProgress({ done, total }));
        if (why) return setErr(why);
        hapticSent();
        // 发出去了才清空:失败时把人打的字和选的文件一起吞掉是不可接受的
        setText("");
        setFiles([]);
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setProgress(null);
      }
    })();
  };

  return (
    <View style={{
      paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.md, gap: space.xs,
      borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border,
      backgroundColor: c.background,
    }}>
      {/* 桌面回来的话在最上面,而且要能按掉 —— 它说的是上一次发送的事 */}
      {notice ? (
        <Pressable onPress={onDismissNotice} accessibilityRole="button">
          <Note tone="error">{notice}</Note>
        </Pressable>
      ) : null}
      {err ? <Note tone="error">{err}</Note> : null}
      {progress ? (
        <Meta>{progress.total ? `传附件 ${progress.done}/${progress.total} 片…` : "处理附件…"}</Meta>
      ) : null}

      {files.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space.xs, paddingVertical: 2 }}>
          {files.map((f, i) => (
            <Chip key={`${f.uri}#${i}`} file={f}
              onRemove={busy ? undefined : () => setFiles((p) => p.filter((_x, j) => j !== i))} />
          ))}
        </ScrollView>
      ) : null}

      <View style={{ flexDirection: "row", alignItems: "flex-end", gap: space.sm }}>
        {/* ＋ 和桌面输入区左下角那个同一个位置、同一个意思 */}
        <Pressable
          accessibilityRole="button" accessibilityLabel="加附件"
          onPress={openPicker} disabled={busy} hitSlop={8}
          style={({ pressed }) => [
            {
              width: 44, height: 44, borderRadius: radius.pill,
              alignItems: "center", justifyContent: "center",
              borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
            },
            busy && { opacity: 0.35 },
            pressed && !busy && { opacity: 0.6 },
          ]}
        >
          <Text style={{ ...t.title, color: c.foreground, marginTop: -2 }}>＋</Text>
        </Pressable>
        <TextInput
          style={{
            flex: 1, backgroundColor: c.card, color: c.foreground,
            borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
            paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11,
            // 长文本自己长高,但到五六行就封顶——再高就把时间线挤没了
            maxHeight: 132, ...t.body,
          }}
          placeholder={online ? "回一条…" : "断开了,连回来再发"}
          placeholderTextColor={c.mutedForeground}
          multiline value={text} onChangeText={setText}
        />
        <Pressable
          accessibilityRole="button" accessibilityLabel="发送"
          onPress={submit} disabled={!ready} hitSlop={8}
          style={({ pressed }) => [
            {
              width: 44, height: 44, borderRadius: radius.pill,
              alignItems: "center", justifyContent: "center",
              backgroundColor: c.primary,
            },
            !ready && { opacity: 0.35 },
            pressed && ready && { opacity: 0.8 },
          ]}
        >
          {busy
            ? <ActivityIndicator color={c.primaryForeground} />
            : <Text style={{ ...t.headline, color: c.primaryForeground }}>↑</Text>}
        </Pressable>
      </View>
    </View>
  );
}

/** 一个待发的附件。名字一行截断 —— 手机上文件名能有半屏那么长 */
function Chip({ file, onRemove }: { file: Picked; onRemove?: () => void }) {
  const { c } = usePalette();
  const kb = file.bytes ? `${Math.max(1, Math.round(file.bytes / 1024))}KB` : "";
  return (
    <View style={{
      flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: 220,
      paddingLeft: space.sm, paddingRight: onRemove ? 4 : space.sm, paddingVertical: 6,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <Text style={{ ...t.footnote, color: c.foreground, flexShrink: 1 }} numberOfLines={1}>
        {file.name}
      </Text>
      {kb ? <Meta>{kb}</Meta> : null}
      {onRemove ? (
        <Pressable
          accessibilityRole="button" accessibilityLabel={`移除 ${file.name}`}
          onPress={onRemove} hitSlop={8}
          style={({ pressed }) => [
            { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
            pressed && { opacity: 0.5 },
          ]}
        >
          <Text style={{ ...t.footnote, color: c.mutedForeground }}>✕</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** 一条消息。三种角色三种读法,和桌面对话视图一致:
    user 是右边的蓝气泡;
    assistant 是左边的裸正文走 markdown(它篇幅最长,套气泡整屏都是框);
    tool 不在这里 —— 它被 groupTimeline 折叠成一行了。 */
function Msg({ msg: m }: { msg: MobileMessage }) {
  const { c } = usePalette();
  const tail = m.truncated ? <Meta>… 太长了,在电脑上看全文</Meta> : null;

  if (m.role === "user") {
    return (
      <View style={{ alignItems: "flex-end", gap: 2 }}>
        <View style={{
          backgroundColor: c.primary, borderRadius: radius.control,
          paddingHorizontal: space.md, paddingVertical: space.sm, maxWidth: "88%",
        }}>
          {/* 用户打的是纯文本,不当 markdown 解析:把人手打的 * 渲染成粗体是错的 */}
          <Text style={{ ...t.body, color: c.primaryForeground }}>{m.text}</Text>
        </View>
        {tail}
      </View>
    );
  }
  return (
    <View style={{ gap: space.xs, paddingVertical: space.xs }}>
      <Markdown source={m.text} />
      {tail}
    </View>
  );
}

/** 助手正文。解析在 shared/remote/markdown.ts(纯的、跟着根门禁跑),
    这里只负责把块和片段画出来。 */
function Markdown({ source }: { source: string }) {
  const { c } = usePalette();
  const blocks = parseMarkdown(source);
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((b, i) => {
        if (b.kind === "code") return <CodeBlock key={i} lang={b.lang} text={b.text} />;
        if (b.kind === "heading") {
          // 标题只用字号和字重拉开,不加下划线/色块 —— 桌面那侧也是
          const size = b.level <= 2 ? 20 : 17;
          return (
            <Text key={i} style={{ fontSize: size, lineHeight: size + 7, fontWeight: "700",
              letterSpacing: -0.3, color: c.foreground, marginTop: space.xs }}>
              <Spans spans={b.spans} />
            </Text>
          );
        }
        if (b.kind === "bullet" || b.kind === "ordered") {
          return (
            <View key={i} style={{ flexDirection: "row", gap: space.xs }}>
              {/* 记号列固定宽:序号 1 和 10 的正文要对齐 */}
              <Text style={{ ...t.body, color: c.mutedForeground, minWidth: 18, textAlign: "right" }}>
                {b.kind === "bullet" ? "•" : `${b.marker}.`}
              </Text>
              <Text style={{ ...t.body, color: c.foreground, flex: 1 }}>
                <Spans spans={b.spans} />
              </Text>
            </View>
          );
        }
        return (
          <Text key={i} style={{ ...t.body, color: c.foreground }}>
            <Spans spans={b.spans} />
          </Text>
        );
      })}
    </View>
  );
}

/** 行内片段。code 片给一块浅底 + 等宽,和桌面的 `--code-bg` 一个意思 */
function Spans({ spans }: { spans: MdSpan[] }) {
  const { c } = usePalette();
  return (
    <>
      {spans.map((s, i) =>
        s.code ? (
          <Text key={i} style={{
            fontFamily: MONO, fontSize: 14, color: c.foreground, backgroundColor: c.muted,
          }}>
            {` ${s.text} `}
          </Text>
        ) : (
          <Text key={i} style={s.bold ? { fontWeight: "700", color: c.foreground } : undefined}>
            {s.text}
          </Text>
        ),
      )}
    </>
  );
}

/** 代码块。**横向滚动,不换行** —— 代码换行之后缩进就没意义了,
    而缩进是读代码的第一层信息(桌面那侧的代码块也是横着滚的)。 */
function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const { c } = usePalette();
  return (
    <View style={{
      borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
      backgroundColor: c.card, overflow: "hidden",
    }}>
      {lang ? (
        <View style={{
          paddingHorizontal: space.sm + 2, paddingTop: space.xs, paddingBottom: 2,
        }}>
          <Meta>{lang}</Meta>
        </View>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ padding: space.sm + 2 }}>
        <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: c.foreground }}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

/** 折叠起来的一组工具调用。**默认收起** —— 一次 bash 的输出能把整屏占满,
    而人翻这一屏是为了看模型说了什么。和桌面的 `2 tool calls ›` 同一个形状。 */
function ToolGroup({ tools }: { tools: MobileMessage[] }) {
  const { c } = usePalette();
  const [open, setOpen] = useState(false);
  const names = tools.map((x) => splitTool(x).name);
  const label = tools.length === 1 ? names[0] : `${tools.length} 次工具调用`;

  return (
    <View style={{ gap: space.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={8}
        style={({ pressed }) => [
          { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: 2 },
          pressed && { opacity: 0.5 },
        ]}
      >
        <Text style={{ ...t.footnote, color: c.mutedForeground, fontFamily: MONO }}>
          {label}
        </Text>
        <Text style={{ ...t.footnote, color: c.mutedForeground }}>{open ? "▾" : "›"}</Text>
      </Pressable>
      {open
        ? tools.map((x, i) => {
            const { name, output } = splitTool(x);
            return (
              <View key={i} style={{
                borderRadius: radius.control, borderWidth: StyleSheet.hairlineWidth,
                borderColor: c.border, padding: space.sm + 2, gap: 2,
              }}>
                <Meta>{name}</Meta>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={{ fontFamily: MONO, fontSize: 13, lineHeight: 19, color: c.mutedForeground }}>
                    {output}
                  </Text>
                </ScrollView>
                {x.truncated ? <Meta>… 太长了,在电脑上看全文</Meta> : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

/** 待批的那一块。形状照着桌面的 permission-grant:一条细边围出来的板、行首方块、
    动作行**右对齐的小胶囊**——安静,不抢卡片的主体。
    刻意不做左侧色条、不给它更深的底:更深的底在卡片里读成一个洞,而不是浮起来的一层。 */
export function Approval({ agent: a, onDecide, online }: {
  agent: IslandAgent;
  onDecide: (a: IslandAgent, ok: boolean) => void;
  /** 断线时两个键都按不动。**能按但按了没用是最坏的一种**:审批有时限,
      而一个"批过了"的错觉会让人放下手机走开 */
  online: boolean;
}) {
  const { c } = usePalette();
  const p = a.pendingApproval;
  if (!p) return null;
  return (
    <View style={{
      borderRadius: radius.card, padding: space.md, gap: space.sm, marginTop: space.xs,
      borderWidth: StyleSheet.hairlineWidth, borderColor: c.border,
    }}>
      <View style={{ flexDirection: "row", gap: space.sm }}>
        {/* 方块对齐第一行文字,不是对齐整块的中线 —— 路径换行之后中线会跑偏 */}
        <View style={{ marginTop: 1 }}>
          <Tile>
            <Text style={{ ...t.headline, color: c.warn, fontFamily: MONO }}>!</Text>
          </Tile>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={{ ...t.body, color: c.foreground, fontFamily: MONO }} numberOfLines={1}>
            {p.verb} {p.target}
          </Text>
          {p.fullPath ? <Meta>{p.fullPath}</Meta> : null}
        </View>
      </View>
      {/* 顺序和轻重跟桌面 permission-grant 一致:拒绝是不着色的纯文字,批准是实底的;
          确认动作在右,和 iOS 弹窗一个方向。拒绝不染红——红是"这个动作危险"的意思,
          而这里危险的是批准 */}
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: space.xs }}>
        {online ? null : <Meta>断开了,按不了</Meta>}
        <Button size="auto" variant="quiet" label="拒绝" disabled={!online} onPress={() => onDecide(a, false)} />
        <Button size="auto" label="批准" disabled={!online} onPress={() => onDecide(a, true)} />
      </View>
    </View>
  );
}
