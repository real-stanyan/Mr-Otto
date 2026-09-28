// WxAvatar —— 微信式布局里的头像（#1386 桌面那一半）：智能体 = 像素脸、人 = 头像图或首字、
// 群 = 九宫格拼图。形状照微信：圆角方块，不是圆（手机那一份是 mobile/src/wx/Avatar.tsx）。
//
// 九宫格怎么排（几列、不满的那一行放最上面）的判据在 `src/shared/wechatInbox.ts` 的
// `gridLayout`，手机与桌面共用一份；这里只照着摆。

import { useState } from "react";
import { cn } from "@/lib/utils.js";
import { AgentFace } from "../components/AgentFace.js";
import type { FaceState } from "../lib/ottoFace/index.js";
import { gridLayout, initialOf, type AvatarSpec, type GridCell } from "../../../shared/wechatInbox.js";
import { DISC_COLOR } from "../../../shared/ottoFace/index.js";

/** 圆角随尺寸走（约 16%）。AgentFace 不收 style，所以按档给类名而不是现算一个像素值 */
export function radiusClass(size: number): string {
  if (size <= 16) return "rounded-[3px]";
  if (size <= 26) return "rounded-[4px]";
  if (size <= 38) return "rounded-[6px]";
  if (size <= 48) return "rounded-[7px]";
  if (size <= 64) return "rounded-[10px]";
  return "rounded-[14px]";
}

/** 一个人：有头像图画图，没有（或图坏了）画名字的第一个字 */
export function WxPerson({
  name,
  url,
  size,
  className,
  label,
}: {
  name: string;
  url: string;
  size: number;
  className?: string;
  /** 给读屏的一句话；不给就 aria-hidden（名字几乎总在旁边） */
  label?: string;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <span
      {...(label === undefined ? { "aria-hidden": true } : { role: "img", "aria-label": label })}
      className={cn(
        "relative grid shrink-0 place-items-center overflow-hidden bg-muted font-semibold leading-none text-muted-foreground select-none",
        radiusClass(size),
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * 0.42)) }}
    >
      {url !== "" && !broken ? (
        <img
          src={url}
          alt=""
          draggable={false}
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          className="size-full object-cover"
        />
      ) : (
        initialOf(name)
      )}
    </span>
  );
}

/** 一只智能体的脸。默认 `plain`（我们不知道它此刻在干嘛），会动的只有调用方明说的那几格。
    脸是画在一枚纸白圆盘上的（ottoFace/paint.ts）；微信的头像是圆角方块，所以底下垫一块同色的方块——
    圆盘与方块同一个颜色（DISC_COLOR，两个主题同值），看上去就是一张方形的脸（demo 的 `.av` 同一个做法） */
export function WxFace({
  slot,
  size,
  state,
  className,
  label,
}: {
  slot: number;
  size: number;
  state?: FaceState;
  className?: string;
  label?: string;
}) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center overflow-hidden", radiusClass(size), className)}
      style={{ width: size, height: size, background: DISC_COLOR }}
    >
      <AgentFace
        slot={slot}
        size={size}
        {...(state === undefined ? {} : { state })}
        {...(label === undefined ? {} : { label })}
        className="rounded-none"
      />
    </span>
  );
}

function Mini({ cell, size }: { cell: GridCell; size: number }) {
  if (cell.kind === "face") {
    return (
      <span className="grid shrink-0 place-items-center overflow-hidden rounded-[2px]" style={{ width: size, height: size, background: DISC_COLOR }}>
        <AgentFace slot={cell.slot} size={size} className="rounded-none" />
      </span>
    );
  }
  return <WxPerson name={cell.name} url={cell.url} size={size} className="rounded-[2px] bg-foreground/[0.12]" />;
}

/** 九宫格拼图：人在前、智能体在后（顺序由调用方给，wechatInbox 里定好了） */
export function WxGrid({ cells, size, className }: { cells: readonly GridCell[]; size: number; className?: string }) {
  const { rows, cell, gap, pad } = gridLayout(cells.length, size);
  let i = 0;
  return (
    <span
      aria-hidden
      className={cn("flex shrink-0 flex-col justify-center bg-muted", radiusClass(size), className)}
      style={{ width: size, height: size, padding: pad, gap }}
    >
      {rows.map((n, r) => {
        const row = cells.slice(i, i + n);
        i += n;
        return (
          <span key={r} className="flex justify-center" style={{ gap }}>
            {row.map((c, k) => (
              <Mini key={k} cell={c} size={cell} />
            ))}
          </span>
        );
      })}
    </span>
  );
}

/** 列表那一行的头像：三种说法一个入口 */
export function WxAvatar({ spec, size, className }: { spec: AvatarSpec; size: number; className?: string }) {
  if (spec.kind === "face") return <WxFace slot={spec.slot} size={size} {...(className === undefined ? {} : { className })} />;
  if (spec.kind === "person") return <WxPerson name={spec.name} url={spec.url} size={size} {...(className === undefined ? {} : { className })} />;
  return <WxGrid cells={spec.cells} size={size} {...(className === undefined ? {} : { className })} />;
}
