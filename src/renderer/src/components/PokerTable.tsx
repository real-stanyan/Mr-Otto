// 德州牌桌（game 档）。
//
// 牌局状态一律来自服务端推来的**裁剪过的**视图：别人的底牌在这份数据里就是 null，
// 渲染层拿不到，也就不可能不小心画出来。这里没有任何一处自己算牌的逻辑。
//
// 动效用 GSAP（ADR-0024）：发牌是一串有先后的动作，翻公共牌要接在上一个之后，
// 这类编排用 timeline 表达，CSS 的 transition-delay 硬编时间点改一次就要重算全部。

import gsap from "gsap";
import { useEffect, useRef, useState } from "react";
import { RANKS, SUITS, rankOf, suitOf } from "../../../../services/gateway/src/poker/cards.js";
import type { PokerHandView, PokerTableSummary } from "../../../shared/shellBridge.js";
import { actionLabel, applyUnit, seatIdentity, seatPosition } from "../lib/pokerSeat.js";
import { splitFlapFrame, splitFlapTotalTicks } from "../lib/splitFlap.js";
import { useChat } from "../store.js";
import ottoLogo from "../assets/otto.png";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

/**
 * 请求飞行期间禁用自己的按钮。
 *
 * 裸 onClick 直接 fire-and-forget 的代价是真金白银:建桌点两下就是两张桌(实测，
 * 相隔 1 秒的两行)，而建桌这条路服务端没有幂等键 —— 买入/结算有(request_id)，
 * 建桌没有。牌桌上的动作更狠:跟注点两下、加注点两下，都是往池子里再推一笔。
 *
 * 禁用而不是节流:节流只是把第二次点击往后挪，禁用才表达"这一次还没落地"。
 */
function AsyncButton({
  onClick,
  disabled,
  children,
  ...rest
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
  onClick: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Button
      {...rest}
      disabled={disabled === true || pending}
      onClick={() => {
        if (pending) return;
        setPending(true);
        void onClick().finally(() => setPending(false));
      }}
    >
      {children}
    </Button>
  );
}

/** 花色符号与配色。红黑之分是牌桌的基本可读性，不是装饰 */
const SUIT_GLYPH = ["♣", "♦", "♥", "♠"] as const;
const isRed = (card: number) => suitOf(card) === 1 || suitOf(card) === 2;

const fmt = (n: number) => n.toLocaleString("en-US");

export function CardBack({ className = "" }: { className?: string }) {
  return (
    <div
      className={`relative aspect-[5/7] rounded-[7px] border border-border bg-gradient-to-b from-card to-[color-mix(in_srgb,var(--card)_86%,var(--foreground))] shadow-sm overflow-hidden ${className}`}
      aria-hidden
    >
      <div className="absolute inset-[3px] rounded-[4px] border border-border/50" />
      <img src={ottoLogo} alt="" className="absolute inset-0 m-auto w-[56%] opacity-90 select-none" draggable={false} />
    </div>
  );
}

/**
 * 牌面照真扑克画：白底、左上/右下对角角标（点数在上花色在下）、中央大花色。
 * 字号全部用 cqw（相对卡片自身宽度），一份布局从 28px 的对手牌缩放到 64px
 * 的手牌都不溢出 —— 之前居中一行 20px 文字塞 24px 宽的卡，两张牌叠成一团。
 * 白底是刻意的：现实里扑克就是白的，深浅主题下都不跟着变。
 */
function CardFace({ card, className = "" }: { card: number; className?: string }) {
  const rank = RANKS[rankOf(card)];
  const suit = SUIT_GLYPH[suitOf(card)];
  const corner = (
    <span className="flex flex-col items-center leading-none">
      <span className="font-bold" style={{ fontSize: "30cqw" }}>{rank}</span>
      <span style={{ fontSize: "24cqw" }}>{suit}</span>
    </span>
  );
  return (
    <div
      className={`relative aspect-[5/7] select-none rounded-[7px] border border-black/20 bg-white shadow-sm ${className}`}
      aria-label={`${RANKS[rankOf(card)]} ${SUITS[suitOf(card)]}`}
      style={{ color: isRed(card) ? "#d92d20" : "#1c1c1e", containerType: "inline-size" } as React.CSSProperties}
    >
      <span className="absolute left-[7%] top-[6%]">{corner}</span>
      <span className="absolute bottom-[6%] right-[7%] rotate-180">{corner}</span>
      <span
        className="absolute inset-0 flex items-center justify-center"
        style={{ fontSize: "48cqw" }}
      >
        {suit}
      </span>
    </div>
  );
}

/**
 * split-flap 数字（机场翻牌板）。底池变了,每一位滚过一串数字再落定,
 * 从左到右一列列停 —— 钱的变化值得一个能看见的动作,但只在变化时动,
 * 静止的板子完全安静。prefers-reduced-motion 下直接跳到目标值。
 */
function SplitFlapNumber({ text }: { text: string }) {
  const [display, setDisplay] = useState(text);
  const prev = useRef(text);

  useEffect(() => {
    if (text === prev.current) return;
    const from = prev.current;
    prev.current = text;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(text);
      return;
    }
    let tick = 0;
    const total = splitFlapTotalTicks(text);
    const id = setInterval(() => {
      tick += 1;
      setDisplay(splitFlapFrame(from, text, tick, "0123456789,"));
      if (tick >= total) clearInterval(id);
    }, 45);
    return () => {
      clearInterval(id);
      setDisplay(text);
    };
  }, [text]);

  return (
    <span className="inline-flex gap-[2px]" aria-label={text}>
      {display.split("").map((ch, i) => (
        <span
          key={i}
          className="relative inline-flex h-[1.55em] min-w-[1.05em] items-center justify-center overflow-hidden rounded-[3px] border border-border/70 bg-card font-semibold tabular-nums shadow-sm after:absolute after:inset-x-0 after:top-1/2 after:h-px after:bg-foreground/15"
        >
          {ch}
        </span>
      ))}
    </span>
  );
}

/**
 * 行动气泡：座位在当前街的最后一个动作,浮在头像上方。数据来自服务端
 * view 的 lastAction(公开信息),换街自然清空。内容变了弹一下 ——
 * 从 0.9 起手不是 0:现实里没有东西从虚无里长出来。
 */
function ActionBubble({ action }: { action: { kind: string; amount: number } | null | undefined }) {
  const ref = useRef<HTMLDivElement>(null);
  const label = action ? actionLabel(action) : null;

  useEffect(() => {
    if (!ref.current || !label) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.fromTo(
      ref.current,
      { opacity: 0, y: 5, scale: 0.9 },
      { opacity: 1, y: 0, scale: 1, duration: 0.18, ease: "power3.out" }
    );
  }, [label]);

  if (!label) return null;
  return (
    <div
      ref={ref}
      className={`absolute -top-6 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium shadow-sm ${
        action!.kind === "fold"
          ? "border-border bg-card text-muted-foreground"
          : "border-primary/50 bg-primary/10 text-primary"
      }`}
    >
      {label}
    </div>
  );
}

/** 座位头像。没有图就用名字首字的圆片,别让 img 的裂图标出来 */
function SeatAvatar({ name, url }: { name: string; url: string }) {
  if (url) {
    return <img src={url} alt="" className="h-5 w-5 shrink-0 rounded-full object-cover" draggable={false} />;
  }
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
      {(name || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * 胜局结算动画。一手结束且有人赢钱时满屏盖一层:赢家头像+名字,
 * 原有筹码和涨幅,进度条推满 + 大数字从旧滚到新。点哪都关,5s 自动关;
 * 同一手只放一次(按 handId 记账),不挡"下一手"。
 */
function WinOverlay({ hand }: { hand: PokerHandView }) {
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const account = useChat((s) => s.account);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const numRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const deltas = hand.deltas;
  const winnerSeat = deltas
    ? hand.seats.reduce<(typeof hand.seats)[number] | null>((best, s) => {
        const w = deltas[s.userId] ?? 0;
        if (w <= 0) return best;
        return !best || w > (deltas[best.userId] ?? 0) ? s : best;
      }, null)
    : null;
  const won = winnerSeat ? (deltas?.[winnerSeat.userId] ?? 0) : 0;
  const active = hand.done && winnerSeat !== null && dismissedFor !== hand.handId;

  useEffect(() => {
    if (!active || !winnerSeat) return;
    const el = numRef.current;
    const bar = barRef.current;
    if (!el || !bar) return;
    const from = winnerSeat.stack - won;
    const target = winnerSeat.stack;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.textContent = fmt(target);
      gsap.set(bar, { width: "100%" });
      return;
    }
    const obj = { v: from };
    const tl = gsap.timeline();
    tl.fromTo(bar, { width: "0%" }, { width: "100%", duration: 1.4, ease: "power2.out" }, 0);
    tl.to(
      obj,
      {
        v: target,
        duration: 1.4,
        ease: "power2.out",
        onUpdate: () => {
          el.textContent = fmt(Math.round(obj.v));
        },
      },
      0
    );
    return () => {
      tl.kill();
    };
  }, [active, winnerSeat?.userId, hand.handId]);

  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => setDismissedFor(hand.handId), 5000);
    return () => clearTimeout(t);
  }, [active, hand.handId]);

  if (!active || !winnerSeat) return null;
  const who = seatIdentity(winnerSeat, friends, account.name, account.avatarUrl);
  const from = winnerSeat.stack - won;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background/80 backdrop-blur-sm"
      onClick={() => setDismissedFor(hand.handId)}
      role="dialog"
      aria-label="本手结算"
    >
      <div className="flex flex-col items-center gap-2">
        {who.avatarUrl ? (
          <img src={who.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" draggable={false} />
        ) : (
          <span className="grid h-16 w-16 place-items-center rounded-full bg-primary/15 text-2xl font-semibold text-primary">
            {(who.name || "?").slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="text-lg font-semibold">{who.name}</div>
        <div className="text-sm tabular-nums text-muted-foreground">
          原有 {fmt(from)}
          <span className="ml-1 font-semibold text-primary">+{fmt(won)}</span>
        </div>
      </div>
      <span ref={numRef} className="text-4xl font-bold tabular-nums">
        {fmt(from)}
      </span>
      <div className="h-2 w-[min(60vw,420px)] overflow-hidden rounded-full bg-border/60">
        <div ref={barRef} className="h-full w-0 rounded-full bg-primary" />
      </div>
      <div className="text-[11px] text-muted-foreground">点击任意处关闭</div>
    </div>
  );
}

/** 发牌与翻牌的编排。handId 变 = 新一手，board 变长 = 翻了新街 */
function useDealMotion(hand: PokerHandView | null) {
  const root = useRef<HTMLDivElement>(null);
  const lastHand = useRef<string | null>(null);
  const lastBoard = useRef(0);

  useEffect(() => {
    if (!root.current || !hand) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ctx = gsap.context(() => {
      if (hand.handId !== lastHand.current) {
        lastHand.current = hand.handId;
        lastBoard.current = 0;
        const cards = gsap.utils.toArray<HTMLElement>("[data-hole]");
        // 从桌心飞向座位:牌是发出去的,不是凭空出现在手边的
        if (reduce) gsap.set(cards, { opacity: 1, x: 0, y: 0, scale: 1 });
        else {
          gsap.fromTo(
            cards,
            { opacity: 0, x: () => 0, y: -60, scale: 0.7 },
            { opacity: 1, x: 0, y: 0, scale: 1, duration: 0.32, ease: "power3.out", stagger: 0.05 }
          );
        }
      }
      if (hand.board.length > lastBoard.current) {
        const fresh = gsap.utils
          .toArray<HTMLElement>("[data-board]")
          .slice(lastBoard.current, hand.board.length);
        lastBoard.current = hand.board.length;
        if (reduce) gsap.set(fresh, { opacity: 1, scale: 1 });
        // 从 0.92 而不是 0:现实里没有东西从虚无里长出来
        else {
          gsap.fromTo(
            fresh,
            { opacity: 0, scale: 0.92, rotateY: -25 },
            { opacity: 1, scale: 1, rotateY: 0, duration: 0.36, ease: "power3.out", stagger: 0.08 }
          );
        }
      }
    }, root);
    return () => ctx.revert();
  }, [hand]);

  return root;
}

/** 我坐哪一座 —— 服务端标的 isMe，不拿本地身份去比 */
const mySeat = (hand: PokerHandView) => hand.seats.find((s) => s.isMe) ?? null;

function ActionBar({ hand }: { hand: PokerHandView }) {
  const act = useChat((s) => s.pokerAct);
  const raise = hand.legal.find((o) => o.type === "raise");
  const [to, setTo] = useState<string>("");
  // 单位是输入的放大镜:×1 敲几百,K/M 敲大数。换街重置回 ×1,别让上一街的 M 偷着放大这一街的 50
  const [unit, setUnit] = useState(1);

  useEffect(() => {
    if (raise) {
      setTo(String(raise.minTo));
      setUnit(1);
    }
  }, [raise?.minTo, hand.handId, hand.street]);

  if (hand.toAct !== mySeat(hand)?.userId) {
    return (
      <div className="text-xs text-muted-foreground">
        {hand.done ? "这手牌结束了" : "等别人行动…"}
      </div>
    );
  }

  const call = hand.legal.find((o) => o.type === "call");
  const amount = applyUnit(to, unit);
  const canRaise = raise && Number.isInteger(amount) && amount >= raise.minTo && amount <= raise.maxTo;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hand.legal.some((o) => o.type === "fold") && (
        <AsyncButton size="sm" variant="outline" onClick={() => act({ type: "fold" })}>
          弃牌
        </AsyncButton>
      )}
      {hand.legal.some((o) => o.type === "check") && (
        <AsyncButton size="sm" variant="outline" onClick={() => act({ type: "check" })}>
          过牌
        </AsyncButton>
      )}
      {call && (
        <AsyncButton size="sm" onClick={() => act({ type: "call" })}>
          跟注 {fmt(call.amount)}
        </AsyncButton>
      )}
      {raise && (
        <div className="flex items-center gap-1">
          <Input
            className="h-8 w-24 tabular-nums"
            value={to}
            inputMode="numeric"
            onChange={(e) => setTo(e.target.value.replace(/[^\d]/g, ""))}
            aria-label={`加注到（${raise.minTo}..${raise.maxTo}）`}
          />
          <select
            className="h-8 rounded-md border border-border bg-card px-1.5 text-[13px]"
            value={unit}
            onChange={(e) => setUnit(Number(e.target.value))}
            aria-label="金额单位"
          >
            <option value={1}>×1</option>
            <option value={1000}>K</option>
            <option value={1000000}>M</option>
          </select>
          <AsyncButton size="sm" disabled={!canRaise} onClick={() => act({ type: "raise", to: amount })}>
            {canRaise && amount >= raise.maxTo ? "全下" : `加注到${canRaise ? ` ${fmt(amount)}` : ""}`}
          </AsyncButton>
        </div>
      )}
    </div>
  );
}

function Showdown({ hand }: { hand: PokerHandView }) {
  const me = mySeat(hand)?.userId ?? "";
  const mine = hand.deltas?.[me] ?? 0;
  return (
    <div className="flex flex-col items-center gap-1 text-xs">
      <div className={mine > 0 ? "text-primary font-semibold" : "text-muted-foreground"}>
        {mine > 0 ? `赢了 ${fmt(mine)}` : mine < 0 ? `输了 ${fmt(-mine)}` : "打平"}
      </div>
      {/* 承诺-揭示:牌堆在开局就被 hash 钉死了,这行让人自己看得见它被揭开 */}
      {hand.commitment.deck && (
        <details className="text-[11px] text-muted-foreground">
          <summary className="cursor-pointer">牌堆已揭示（可自验）</summary>
          <div className="mt-1 max-w-[420px] break-all font-mono">
            hash {hand.commitment.hash}
            <br />
            salt {hand.commitment.salt}
          </div>
        </details>
      )}
    </div>
  );
}

function Table({ hand }: { hand: PokerHandView }) {
  const root = useDealMotion(hand);
  const leave = useChat((s) => s.leavePokerTable);
  const start = useChat((s) => s.startPokerHand);
  const friends = useChat((s) => s.friendsSnapshot.friends);
  const account = useChat((s) => s.account);
  const n = hand.seats.length;
  const meIndex = hand.seats.findIndex((s) => s.isMe);

  return (
    <div ref={root} className="flex h-full flex-col items-center justify-center gap-4 px-5 py-4">
      {/* 外层是定位场,呢子桌面往里缩:座位块骑在桌沿上,谁都不会被容器裁掉 */}
      <div className="relative aspect-[16/10] w-full max-w-[860px]">
        <div className="absolute inset-x-[9%] inset-y-[13%] rounded-[50%] border border-border/60 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--brand)_14%,var(--card)),var(--card))] shadow-inner" />

        {hand.seats.map((seat, i) => {
          const { left, top } = seatPosition(i, meIndex, n);
          const who = seatIdentity(seat, friends, account.name, account.avatarUrl);
          const acting = hand.toAct === seat.userId;
          return (
            <div
              key={seat.userId}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors duration-150 ${
                acting ? "border-primary bg-primary/[0.08]" : "border-border/70 bg-card/85"
              } ${seat.folded ? "opacity-45" : ""}`}
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <ActionBubble action={seat.lastAction} />
              <div className="flex items-center gap-1.5 text-[11px]">
                <SeatAvatar name={who.name} url={who.avatarUrl} />
                <span className="max-w-[96px] truncate font-medium">{seat.isMe ? "你" : who.name}</span>
                {i === hand.button && (
                  <span className="rounded-full border border-border px-1 text-[10px] text-muted-foreground">D</span>
                )}
              </div>
              <div className="flex gap-1">
                {(seat.hole ?? [null, null]).map((c, k) =>
                  c === null ? (
                    <CardBack key={k} data-hole="" className={seat.isMe ? "w-10" : "w-7"} />
                  ) : (
                    <span key={k} data-hole="" className={`block ${seat.isMe ? "w-10" : "w-7"}`}>
                      <CardFace card={c} />
                    </span>
                  )
                )}
              </div>
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {fmt(seat.stack)}
                {seat.bet > 0 && <span className="ml-1 text-primary">+{fmt(seat.bet)}</span>}
                {seat.allIn && <span className="ml-1">全下</span>}
              </div>
            </div>
          );
        })}

        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
          <div className="flex gap-2">
            {Array.from({ length: 5 }, (_, i) => {
              const card = hand.board[i];
              return (
                <span key={i} data-board="" className="block w-[52px]">
                  {card === undefined ? <CardBack /> : <CardFace card={card} />}
                </span>
              );
            })}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            底池 <SplitFlapNumber text={fmt(hand.pot)} />
          </div>
        </div>
      </div>

      <WinOverlay hand={hand} />

      <div className="flex min-h-[36px] items-center gap-3">
        {hand.done ? (
          <>
            <Showdown hand={hand} />
            <AsyncButton size="sm" onClick={() => start()}>下一手</AsyncButton>
          </>
        ) : (
          <ActionBar hand={hand} />
        )}
        {/* 牌局进行中不给离桌:服务端也会拒,按钮先自己藏起来,别让人点了才知道 */}
        {hand.done && (
          <AsyncButton size="sm" variant="ghost" onClick={() => leave()}>离桌</AsyncButton>
        )}
      </div>
    </div>
  );
}

function CreateTable() {
  const create = useChat((s) => s.createPokerTable);
  const [name, setName] = useState("");
  const [bb, setBb] = useState("50");
  const [tier, setTier] = useState("flash");

  const bigBlind = Number(bb) || 50;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-card/60 p-3">
      <Input className="h-8 w-40" placeholder="桌名" value={name} onChange={(e) => setName(e.target.value)} />
      <Input
        className="h-8 w-24 tabular-nums"
        value={bb}
        inputMode="numeric"
        onChange={(e) => setBb(e.target.value.replace(/[^\d]/g, ""))}
        aria-label="大盲"
      />
      <select
        className="h-8 rounded-md border border-border bg-card px-2 text-[13px]"
        value={tier}
        onChange={(e) => setTier(e.target.value)}
        aria-label="档位"
      >
        <option value="flash">Flash</option>
        <option value="pro">Pro</option>
      </select>
      <AsyncButton
        size="sm"
        onClick={() =>
          create({
            name: name.trim() || "无名桌",
            tier,
            smallBlind: Math.max(1, Math.floor(bigBlind / 2)),
            bigBlind,
            minBuyin: bigBlind * 20,
            maxBuyin: bigBlind * 100,
            maxSeats: 6,
          })
        }
      >
        建桌
      </AsyncButton>
      <span className="text-[11px] text-muted-foreground">
        买入 {fmt(bigBlind * 20)}–{fmt(bigBlind * 100)} token，只有好友能同桌
      </span>
    </div>
  );
}

function Lobby({ tables }: { tables: PokerTableSummary[] }) {
  const join = useChat((s) => s.joinPokerTable);
  const watch = useChat((s) => s.watchPokerTable);
  return (
    <div className="mx-auto flex w-full max-w-[640px] flex-col gap-3 px-5 py-6">
      <CreateTable />
      {tables.length === 0 ? (
        <div className="py-8 text-center text-sm text-muted-foreground">
          还没有桌子。建一张，或等好友建。
        </div>
      ) : (
        tables.map((t) => (
          <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border/60 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{t.name || "无名桌"}</div>
              <div className="text-[11px] tabular-nums text-muted-foreground">
                {t.tier} · 盲注 {fmt(t.smallBlind)}/{fmt(t.bigBlind)} · 买入 {fmt(t.minBuyin)}–{fmt(t.maxBuyin)}
                {t.live && " · 打着"}
              </div>
            </div>
            {t.seated ? (
              <AsyncButton size="sm" variant="outline" onClick={() => watch(t.id)}>回到牌桌</AsyncButton>
            ) : (
              <AsyncButton size="sm" onClick={() => join(t.id, t.minBuyin)}>
                买入 {fmt(t.minBuyin)}
              </AsyncButton>
            )}
          </div>
        ))
      )}
    </div>
  );
}

/** 进了桌但没牌在打：没买入 → 先买入；已在座 → 开牌/离桌 */
function TableIdle({ tableId }: { tableId: string }) {
  const table = useChat((s) => s.pokerTables.find((t) => t.id === tableId) ?? null);
  const join = useChat((s) => s.joinPokerTable);
  const start = useChat((s) => s.startPokerHand);
  const leave = useChat((s) => s.leavePokerTable);

  if (table && !table.seated) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        还没买入。买入的 token 从 {table.tier} 桶里出，输赢只在这张桌上转。
        <AsyncButton size="sm" onClick={() => join(tableId, table.minBuyin)}>
          买入 {fmt(table.minBuyin)}
        </AsyncButton>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      已入座，等开牌（至少两个人才开得起来）。
      <div className="flex gap-2">
        <AsyncButton size="sm" onClick={() => start()}>开一手</AsyncButton>
        <AsyncButton size="sm" variant="ghost" onClick={() => leave()}>离桌</AsyncButton>
      </div>
    </div>
  );
}

export function PokerTable() {
  const tables = useChat((s) => s.pokerTables);
  const tableId = useChat((s) => s.pokerTableId);
  const hand = useChat((s) => s.pokerHand);
  const error = useChat((s) => s.pokerError);
  const account = useChat((s) => s.account);
  const refresh = useChat((s) => s.refreshPokerTables);
  const refreshFriends = useChat((s) => s.refreshFriends);

  useEffect(() => {
    if (!account.signedIn) return;
    void refresh();
    // 座位显示真名+头像靠好友快照;不刷一把,先开牌桌再开好友页的人只能看到 ID
    void refreshFriends();
  }, [account.signedIn, refresh, refreshFriends]);

  if (!account.signedIn) {
    return (
      <section className="flex-1 grid place-items-center text-sm text-muted-foreground">
        先登录才能上牌桌。
      </section>
    );
  }

  return (
    <section className="flex-1 min-h-0 overflow-y-auto scrollbar-stable">
      {error && (
        <div className="mx-5 mt-3 rounded-md border border-err/60 bg-err/[0.06] px-3 py-2 text-xs text-err">
          {error}
        </div>
      )}
      {!tableId ? (
        <Lobby tables={tables} />
      ) : hand ? (
        <Table hand={hand} />
      ) : (
        // 进了桌但没牌在打。这里有两种完全不同的状态，混成一句"加载中"会让人
        // 对着一个买入按钮找不着：建了桌 ≠ 坐下了，得先掏钱买入才有筹码
        <TableIdle tableId={tableId} />
      )}
    </section>
  );
}
