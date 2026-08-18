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
import { useChat } from "../store.js";
import ottoLogo from "../assets/otto.png";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

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

function CardFace({ card, className = "" }: { card: number; className?: string }) {
  const label = `${RANKS[rankOf(card)]}${SUIT_GLYPH[suitOf(card)]}`;
  return (
    <div
      className={`relative aspect-[5/7] rounded-[7px] border border-border bg-card shadow-sm flex items-center justify-center ${className}`}
      aria-label={`${RANKS[rankOf(card)]} ${SUITS[suitOf(card)]}`}
    >
      <span
        className={`font-semibold leading-none tabular-nums ${isRed(card) ? "text-[#e5484d]" : "text-foreground"}`}
        style={{ fontSize: "min(3.2vw, 20px)" }}
      >
        {label}
      </span>
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

  useEffect(() => {
    if (raise) setTo(String(raise.minTo));
  }, [raise?.minTo, hand.handId, hand.street]);

  if (hand.toAct !== mySeat(hand)?.userId) {
    return (
      <div className="text-xs text-muted-foreground">
        {hand.done ? "这手牌结束了" : "等别人行动…"}
      </div>
    );
  }

  const call = hand.legal.find((o) => o.type === "call");
  const amount = Number(to);
  const canRaise = raise && Number.isInteger(amount) && amount >= raise.minTo && amount <= raise.maxTo;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hand.legal.some((o) => o.type === "fold") && (
        <Button size="sm" variant="outline" onClick={() => void act({ type: "fold" })}>
          弃牌
        </Button>
      )}
      {hand.legal.some((o) => o.type === "check") && (
        <Button size="sm" variant="outline" onClick={() => void act({ type: "check" })}>
          过牌
        </Button>
      )}
      {call && (
        <Button size="sm" onClick={() => void act({ type: "call" })}>
          跟注 {fmt(call.amount)}
        </Button>
      )}
      {raise && (
        <div className="flex items-center gap-1">
          <Input
            className="h-8 w-28 tabular-nums"
            value={to}
            inputMode="numeric"
            onChange={(e) => setTo(e.target.value.replace(/[^\d]/g, ""))}
            aria-label={`加注到（${raise.minTo}..${raise.maxTo}）`}
          />
          <Button size="sm" disabled={!canRaise} onClick={() => void act({ type: "raise", to: amount })}>
            {amount >= raise.maxTo ? "全下" : "加注到"}
          </Button>
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
  const n = hand.seats.length;

  return (
    <div ref={root} className="flex h-full flex-col items-center justify-center gap-4 px-5 py-4">
      <div className="relative aspect-[16/10] w-full max-w-[760px] rounded-[999px/40%] border border-border/60 bg-[radial-gradient(120%_100%_at_50%_0%,color-mix(in_srgb,var(--brand)_14%,var(--card)),var(--card))] shadow-inner">
        {hand.seats.map((seat, i) => {
          const angle = (i / n) * Math.PI * 2 + Math.PI / 2;
          const left = 50 + Math.cos(angle) * 42;
          const top = 50 + Math.sin(angle) * 40;
          const acting = hand.toAct === seat.userId;
          return (
            <div
              key={seat.userId}
              className={`absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center gap-1 rounded-lg border px-2 py-1 transition-colors duration-150 ${
                acting ? "border-primary bg-primary/[0.08]" : "border-border/70 bg-card/70"
              } ${seat.folded ? "opacity-45" : ""}`}
              style={{ left: `${left}%`, top: `${top}%` }}
            >
              <div className="flex items-center gap-1 text-[11px]">
                <span className="max-w-[90px] truncate">{seat.isMe ? "你" : seat.userId.slice(0, 6)}</span>
                {i === hand.button && <span className="rounded-full border border-border px-1">D</span>}
              </div>
              <div className="flex gap-[3px]">
                {(seat.hole ?? [null, null]).map((c, k) =>
                  c === null ? (
                    <CardBack key={k} data-hole="" className="w-6" />
                  ) : (
                    <span key={k} data-hole="" className="block w-6">
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
          <div className="text-xs tabular-nums text-muted-foreground">底池 {fmt(hand.pot)}</div>
        </div>
      </div>

      <div className="flex min-h-[36px] items-center gap-3">
        {hand.done ? (
          <>
            <Showdown hand={hand} />
            <Button size="sm" onClick={() => void start()}>下一手</Button>
          </>
        ) : (
          <ActionBar hand={hand} />
        )}
        {/* 牌局进行中不给离桌:服务端也会拒,按钮先自己藏起来,别让人点了才知道 */}
        {hand.done && (
          <Button size="sm" variant="ghost" onClick={() => void leave()}>离桌</Button>
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
      <Button
        size="sm"
        onClick={() =>
          void create({
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
      </Button>
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
              <Button size="sm" variant="outline" onClick={() => void watch(t.id)}>回到牌桌</Button>
            ) : (
              <Button size="sm" onClick={() => void join(t.id, t.minBuyin)}>
                买入 {fmt(t.minBuyin)}
              </Button>
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
        <Button size="sm" onClick={() => void join(tableId, table.minBuyin)}>
          买入 {fmt(table.minBuyin)}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      已入座，等开牌（至少两个人才开得起来）。
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void start()}>开一手</Button>
        <Button size="sm" variant="ghost" onClick={() => void leave()}>离桌</Button>
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

  useEffect(() => {
    if (account.signedIn) void refresh();
  }, [account.signedIn, refresh]);

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
