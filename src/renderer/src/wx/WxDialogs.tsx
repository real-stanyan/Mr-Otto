// WxDialogs —— 桌面微信式布局（#1386）里的几张居中弹窗：新建智能体、挑人（建群 / 拉人 / 移人，
// 智能体与朋友两段，#1393）、添加朋友、改一格字、改密码、换形象。
//
// 一个宿主（`WxDialogHost`）+ 一个开口（`useWxDialog()`）：弹窗从哪儿叫出来的都有（列表头的 ⊕、
// 通讯录、资料页、聊天信息抽屉），而它们互不嵌套——同一时刻只开一张，开新的等于换一张。
// 每开一次铸一个 id 当 key：上一张的输入不会带到下一张。
//
// 判据全用现成的：智能体名字 `newAgentNameError`、建一只的两步 `createNewAgentFlow`（ADR-0319，
// 与手机同一份）、群名 `mixedGroupName`、名单顺序 `rosterOrder`、密码 `passwordProblem`。

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { cn } from "@/lib/utils.js";
import { useChat } from "../store.js";
import { WxFace, WxPerson } from "./WxAvatar.js";
import { toast } from "./toast.js";
import { ForgotPasswordDialog } from "../components/ForgotPasswordDialog.js";
import { agentFaceSlot } from "../../../shared/agentAvatar.js";
import { homeOf } from "../../../shared/agentRoster.js";
import { pickableFaces, type PickableFace } from "../../../shared/agentSettingsForm.js";
import { mixedGroupName } from "../../../shared/chatGuests.js";
import type { FriendProfile } from "../../../shared/friends.js";
import { rosterOrder } from "../../../shared/groupEdit.js";
import { createNewAgentFlow, defaultPickFor, newAgentNameError } from "../../../shared/newAgentForm.js";
import { passwordProblem, passwordReady } from "../../../shared/profileEdit.js";
import { friendName } from "../../../shared/wechatInbox.js";
import { AGENT_NAME_MAX } from "../../../shared/workspaceAgents.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

// ── 类型 ─────────────────────────────────────────────────────────────

/** 挑人那张单子上的一个人（朋友 / 群里的人） */
export interface PickPerson {
  uid: string;
  name: string;
  url: string;
  /** 第二行（邮箱 / 备注），可空 */
  sub?: string;
}

export interface PickSpec {
  title: string;
  desc?: string;
  /** 画脸、按名册排序用；只挑人时可以是 null */
  ws: WorkspaceSnapshot | null;
  /** 能挑的智能体（名册顺序） */
  agents: readonly string[];
  /** 能挑的人 */
  people: readonly PickPerson[];
  /** 人那一段的小标题：拉人时是「朋友」，移出时是「群里的人」 */
  peopleLabel?: string;
  presetAgents?: readonly string[];
  presetPeople?: readonly string[];
  /** 最多挑几只智能体（拉人时 = 6 − 群里已有的） */
  maxAgents: number;
  maxPeople: number;
  /** 至少挑几位（智能体 + 人合起来） */
  min: number;
  okLabel: string;
  /** 要不要一格群名（发起群聊才要；留空用成员名拼） */
  withName?: boolean;
  /** 做完了回 null；做不成回一句人话（弹窗留着、那句话画在底下） */
  onOk: (r: { agents: string[]; people: string[]; name: string }) => Promise<string | null>;
}

export interface EditSpec {
  title: string;
  desc?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  /** 空着能不能存（「还有什么要交代的」可以清空，名字不行） */
  allowEmpty?: boolean;
  /** 存好了回 null；存不成回一句人话 */
  onSave: (value: string) => Promise<string | null>;
}

export interface FaceSpec {
  title: string;
  current: number;
  onSave: (slot: number) => Promise<string | null>;
}

export type WxDialogRequest =
  | { kind: "newAgent"; onCreated: (agentId: string, sessionId: string, name: string) => void }
  | { kind: "pick"; spec: PickSpec }
  | { kind: "addFriend" }
  | { kind: "edit"; spec: EditSpec }
  | { kind: "password" }
  | { kind: "face"; spec: FaceSpec };

const OpenCtx = createContext<(d: WxDialogRequest) => void>(() => {});

/** 叫出一张弹窗 */
export function useWxDialog(): (d: WxDialogRequest) => void {
  return useContext(OpenCtx);
}

export function WxDialogHost({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ id: number; d: WxDialogRequest } | null>(null);
  const seq = useRef(0);
  const open = useCallback((d: WxDialogRequest) => {
    seq.current += 1;
    setReq({ id: seq.current, d });
  }, []);
  const close = useCallback(() => setReq(null), []);
  return (
    <OpenCtx.Provider value={open}>
      {children}
      {req !== null && <DialogSwitch key={req.id} d={req.d} onClose={close} />}
    </OpenCtx.Provider>
  );
}

function DialogSwitch({ d, onClose }: { d: WxDialogRequest; onClose: () => void }) {
  switch (d.kind) {
    case "newAgent":
      return <NewAgentDialog onClose={onClose} onCreated={d.onCreated} />;
    case "pick":
      return <PickMembersDialog spec={d.spec} onClose={onClose} />;
    case "addFriend":
      return <AddFriendDialog onClose={onClose} />;
    case "edit":
      return <EditTextDialog spec={d.spec} onClose={onClose} />;
    case "password":
      return <PasswordDialog onClose={onClose} />;
    case "face":
      return <FaceDialog spec={d.spec} onClose={onClose} />;
  }
}

/** 弹窗的壳：标题 + 一句说明 + 正文 + 底下两颗钮。`locked` 时点外面 / Esc 不关（正在建的那几秒） */
function Shell({
  title,
  desc,
  children,
  footer,
  onClose,
  locked = false,
  wide = false,
}: {
  title: string;
  desc?: string | undefined;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  locked?: boolean;
  wide?: boolean;
}) {
  return (
    <Dialog open onOpenChange={(o) => { if (!o && !locked) onClose(); }}>
      <DialogContent
        showCloseButton={false}
        className={cn("gap-3.5 p-5", wide ? "sm:max-w-[440px]" : "sm:max-w-[400px]")}
        onInteractOutside={(e) => { if (locked) e.preventDefault(); }}
        onEscapeKeyDown={(e) => { if (locked) e.preventDefault(); }}
      >
        <DialogHeader className="gap-1 text-left">
          <DialogTitle>{title}</DialogTitle>
          {desc !== undefined ? <DialogDescription>{desc}</DialogDescription> : <DialogDescription className="sr-only">{title}</DialogDescription>}
        </DialogHeader>
        {children}
        <DialogFooter className="mt-1 flex-row justify-end gap-2">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ErrorLine({ text }: { text: string | null }) {
  if (text === null || text === "") return null;
  return (
    <p role="alert" className="-mt-1 text-[12px] leading-relaxed text-err">
      {text}
    </p>
  );
}

// ── 形象墙 ───────────────────────────────────────────────────────────

function FaceWall({ selected, onPick }: { selected: number; onPick: (f: PickableFace) => void }) {
  const faces = useMemo(() => pickableFaces(), []);
  return (
    <div className="grid grid-cols-5 gap-2" role="radiogroup" aria-label="形象">
      {faces.map((f) => (
        <button
          key={f.id}
          type="button"
          role="radio"
          aria-checked={f.slot === selected}
          title={f.name}
          onClick={() => onPick(f)}
          className={cn(
            "grid place-items-center rounded-[12px] p-1 transition-[box-shadow,transform] duration-150 active:scale-[0.95]",
            f.slot === selected ? "ring-2 ring-brand" : "hover:bg-foreground/[0.05]",
          )}
        >
          <WxFace slot={f.slot} size={52} />
        </button>
      ))}
    </div>
  );
}

// ── 新建智能体 ───────────────────────────────────────────────────────

function NewAgentDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (agentId: string, sessionId: string, name: string) => void;
}) {
  const home = useChat((s) => homeOf(s.workspaceGroups));
  const createHomeAgent = useChat((s) => s.createHomeAgent);
  const createHomeDm = useChat((s) => s.createHomeDm);
  const clearGreeting = useChat((s) => s.clearHomeAgentGreeting);
  // 默认那张脸：按一个临时 id 派生（真 id 在主进程里铸，落库前这一屏拿不到）——派生只是为了
  // 「一墙新建出来的不至于长成同一张脸」，落库写的是**选中那张**自己的坑位，不按 id 再派生一次
  const [face, setFace] = useState<PickableFace>(() =>
    home === null ? pickableFaces()[0]! : defaultPickFor(home, `a_new${Math.random().toString(16).slice(2, 10)}`),
  );
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agentIdRef = useRef<string | null>(null);
  const flow = useMemo(
    () =>
      createNewAgentFlow({
        insert: async (input) => {
          const r = await createHomeAgent(input.name, input.avatarSlot);
          if (!r.ok) throw new Error(r.message);
          agentIdRef.current = r.agentId;
        },
        openDm: () => createHomeDm(agentIdRef.current ?? ""),
        clearGreeting: () => clearGreeting(agentIdRef.current ?? ""),
      }),
    [createHomeAgent, createHomeDm, clearGreeting],
  );
  const [linking, setLinking] = useState(false);
  const existing = useMemo(() => (home?.agents ?? []).map((a) => a.name), [home]);
  const nameError = name.trim() === "" ? null : newAgentNameError(name, existing);
  const canCreate = !busy && name.trim() !== "" && nameError === null && home !== null;

  const submit = async (): Promise<void> => {
    if (!canCreate && !linking) return;
    setBusy(true);
    setError(null);
    const r = await flow.submit({ name: name.trim(), avatarSlot: face.slot });
    setBusy(false);
    if (!r.ok) {
      setLinking(flow.step() === "linking");
      setError(r.message);
      return;
    }
    onClose();
    onCreated(agentIdRef.current ?? "", r.sessionId, name.trim());
  };

  const cancel = (): void => {
    if (busy) return;
    // 行已落、私聊没建成：把「先开口」那一格清掉，否则之后从草稿发第一句会双答
    void flow.abandon();
    onClose();
  };

  return (
    <Shell
      title="新建智能体"
      desc="起个名字、挑张脸。建好它会先跟你打招呼，你回的第一句话就是它的职责。"
      onClose={cancel}
      locked={busy}
      wide
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={cancel}>
            取消
          </Button>
          <Button disabled={linking ? busy : !canCreate} onClick={() => void submit()}>
            {busy ? "正在建…" : linking ? "再试一次" : "创建"}
          </Button>
        </>
      }
    >
      <div className="flex justify-center pt-1">
        <WxFace slot={face.slot} size={88} state="alive" />
      </div>
      <div className="flex flex-col gap-1">
        <Input
          value={name}
          autoFocus
          disabled={linking || busy}
          maxLength={AGENT_NAME_MAX}
          placeholder="名字，比如「客服」「小周」"
          aria-label="名字"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        {nameError !== null && <p className="px-0.5 text-[12px] text-err">{nameError}</p>}
      </div>
      {!linking && <FaceWall selected={face.slot} onPick={setFace} />}
      <ErrorLine text={error} />
      {home === null && <ErrorLine text="你的智能体还没准备好（主场还没建起来），稍等一下再试。" />}
    </Shell>
  );
}

// ── 挑人 ─────────────────────────────────────────────────────────────

function PickRow({
  avatar,
  name,
  sub,
  on,
  locked,
  onToggle,
}: {
  avatar: ReactNode;
  name: string;
  sub: string;
  on: boolean;
  locked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={on}
      disabled={locked}
      onClick={onToggle}
      className={cn(
        "flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors duration-100",
        "hover:bg-foreground/[0.045] disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent",
      )}
    >
      {avatar}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px]">{name}</span>
        {sub !== "" && <span className="truncate text-[11.5px] text-muted-foreground">{sub}</span>}
      </span>
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-150",
          on ? "border-brand bg-brand text-white" : "border-foreground/25",
        )}
      >
        {on && <Check className="size-3.5" strokeWidth={3} />}
      </span>
    </button>
  );
}

function PickMembersDialog({ spec, onClose }: { spec: PickSpec; onClose: () => void }) {
  const ws = spec.ws;
  const order = (ids: readonly string[]): string[] => (ws === null ? [...ids] : rosterOrder(ws, ids));
  const [agents, setAgents] = useState<string[]>(() => order((spec.presetAgents ?? []).filter((id) => spec.agents.includes(id))));
  const [people, setPeople] = useState<string[]>(() => (spec.presetPeople ?? []).filter((u) => spec.people.some((p) => p.uid === u)));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = agents.length + people.length;
  const enough = total >= spec.min;
  const toggleAgent = (id: string): void =>
    setAgents((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= spec.maxAgents ? cur : order([...cur, id])));
  const togglePerson = (uid: string): void =>
    setPeople((cur) => (cur.includes(uid) ? cur.filter((x) => x !== uid) : cur.length >= spec.maxPeople ? cur : [...cur, uid]));
  const pickedPeople = spec.people.filter((p) => people.includes(p.uid));
  const namePlaceholder =
    total === 0 || ws === null ? "群名（不填就用成员名）" : mixedGroupName(ws, agents, pickedPeople, "");
  const agentName = (id: string): string => ws?.agents.find((a) => a.agentId === id)?.name ?? id;
  const agentRole = (id: string): string => ws?.agents.find((a) => a.agentId === id)?.description ?? "";

  const ok = async (): Promise<void> => {
    if (!enough || busy) return;
    setBusy(true);
    setError(null);
    const r = await spec.onOk({ agents, people, name: name.trim() });
    setBusy(false);
    if (r !== null) {
      setError(r);
      return;
    }
    onClose();
  };

  const counter =
    spec.people.length > 0 && spec.agents.length > 0
      ? `已选 ${agents.length} 只智能体 · ${people.length} 位`
      : spec.agents.length > 0
        ? `已选 ${agents.length} 只 · 最多 ${spec.maxAgents}`
        : `已选 ${people.length} 位`;

  return (
    <Shell
      title={spec.title}
      desc={spec.desc}
      onClose={onClose}
      locked={busy}
      wide
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!enough || busy} onClick={() => void ok()}>
            {busy ? "请稍候…" : spec.okLabel}
          </Button>
        </>
      }
    >
      {spec.withName === true && (
        <Input
          value={name}
          maxLength={60}
          placeholder={namePlaceholder}
          aria-label="群名"
          onChange={(e) => setName(e.target.value)}
        />
      )}
      <div className="-mb-1 text-right text-[11.5px] text-muted-foreground tabular-nums">{counter}</div>
      <div className="-mx-2 max-h-[min(52vh,440px)] overflow-y-auto px-2">
        {spec.agents.length > 0 && (
          <div>
            <div className="px-1 pt-1 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">智能体</div>
            {spec.agents.map((id) => {
              const on = agents.includes(id);
              return (
                <PickRow
                  key={id}
                  avatar={<WxFace slot={ws === null ? 0 : agentFaceSlot(ws, id)} size={30} />}
                  name={agentName(id)}
                  sub={agentRole(id)}
                  on={on}
                  locked={!on && agents.length >= spec.maxAgents}
                  onToggle={() => toggleAgent(id)}
                />
              );
            })}
          </div>
        )}
        {spec.people.length > 0 && (
          <div>
            <div className="px-1 pt-3 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground">
              {spec.peopleLabel ?? "朋友"}
            </div>
            {spec.people.map((p) => {
              const on = people.includes(p.uid);
              return (
                <PickRow
                  key={p.uid}
                  avatar={<WxPerson name={p.name} url={p.url} size={30} />}
                  name={p.name}
                  sub={p.sub ?? ""}
                  on={on}
                  locked={!on && people.length >= spec.maxPeople}
                  onToggle={() => togglePerson(p.uid)}
                />
              );
            })}
          </div>
        )}
        {spec.agents.length === 0 && spec.people.length === 0 && (
          <p className="py-6 text-center text-[13px] text-muted-foreground">没有可以挑的了。</p>
        )}
      </div>
      <ErrorLine text={error} />
    </Shell>
  );
}

// ── 添加朋友 ─────────────────────────────────────────────────────────

function AddFriendDialog({ onClose }: { onClose: () => void }) {
  const searchFriend = useChat((s) => s.searchFriend);
  const addFriend = useChat((s) => s.addFriend);
  const snapshot = useChat((s) => s.friendsSnapshot);
  const selfUid = useChat((s) => s.account.id);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<FriendProfile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());

  const search = async (): Promise<void> => {
    const q = query.trim();
    if (q === "" || busy) return;
    setBusy(true);
    setError(null);
    const list = await searchFriend(q);
    setBusy(false);
    const err = useChat.getState().friendError;
    if (err !== null) setError(err);
    setResults(list.filter((p) => p.id !== selfUid));
  };

  const relation = (uid: string): "friend" | "pending" | "none" => {
    if (snapshot.friends.some((f) => f.profile.id === uid)) return "friend";
    if (sent.has(uid) || snapshot.outgoing.some((f) => f.profile.id === uid) || snapshot.incoming.some((f) => f.profile.id === uid)) return "pending";
    return "none";
  };

  const add = async (p: FriendProfile): Promise<void> => {
    await addFriend(p.id);
    const err = useChat.getState().friendError;
    if (err !== null) {
      setError(err);
      return;
    }
    setSent((s) => new Set([...s, p.id]));
    toast(`申请已发给 ${friendName(p)}，对方同意了会出现在朋友里`);
  };

  return (
    <Shell
      title="添加朋友"
      desc="填对方的邮箱或用户名。加了朋友，才能拉 TA 进群、把你的应用借给 TA。"
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="flex gap-2">
        <Input
          value={query}
          autoFocus
          placeholder="邮箱或用户名"
          aria-label="邮箱或用户名"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void search();
            }
          }}
        />
        <Button variant="secondary" disabled={query.trim() === "" || busy} onClick={() => void search()}>
          {busy ? "查找中…" : "查找"}
        </Button>
      </div>
      {results !== null && (
        <div className="-mx-1 flex max-h-[min(44vh,360px)] flex-col overflow-y-auto">
          {results.length === 0 ? (
            <p className="py-5 text-center text-[13px] text-muted-foreground">没找到这个人。换个写法试试：完整的邮箱最准。</p>
          ) : (
            results.map((p) => {
              const rel = relation(p.id);
              const name = friendName(p);
              return (
                <div key={p.id} className="flex items-center gap-3 rounded-[10px] px-1.5 py-2">
                  <WxPerson name={name} url={p.avatarUrl} size={36} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[14px]">{name}</span>
                    <span className="truncate text-[11.5px] text-muted-foreground">{p.email}</span>
                  </span>
                  {rel === "friend" ? (
                    <span className="text-[12px] text-muted-foreground">已是朋友</span>
                  ) : rel === "pending" ? (
                    <span className="text-[12px] text-muted-foreground">等对方同意</span>
                  ) : (
                    <Button size="sm" onClick={() => void add(p)}>
                      加为朋友
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
      <ErrorLine text={error} />
    </Shell>
  );
}

// ── 改一格字 ─────────────────────────────────────────────────────────

function EditTextDialog({ spec, onClose }: { spec: EditSpec; onClose: () => void }) {
  const [value, setValue] = useState(spec.value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = value.trim() === "";
  const unchanged = value === spec.value;
  const canSave = !busy && !unchanged && (spec.allowEmpty === true || !empty);

  const save = async (): Promise<void> => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const r = await spec.onSave(spec.multiline === true ? value : value.trim());
    setBusy(false);
    if (r !== null) {
      setError(r);
      return;
    }
    onClose();
  };

  return (
    <Shell
      title={spec.title}
      desc={spec.desc}
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      {spec.multiline === true ? (
        <Textarea
          value={value}
          autoFocus
          rows={5}
          {...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength })}
          placeholder={spec.placeholder ?? ""}
          aria-label={spec.title}
          onChange={(e) => setValue(e.target.value)}
          className="max-h-[50vh] min-h-[110px] resize-none text-[14px] leading-[1.6]"
        />
      ) : (
        <Input
          value={value}
          autoFocus
          {...(spec.maxLength === undefined ? {} : { maxLength: spec.maxLength })}
          placeholder={spec.placeholder ?? ""}
          aria-label={spec.title}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
      )}
      <ErrorLine text={error} />
    </Shell>
  );
}

// ── 改密码 ───────────────────────────────────────────────────────────

/**
 * 「现在的密码」对不对：拿它登一次（换来的是同一个人的新 session，别的都不变）；不对就说「现在的密码不对」、
 * 不往下改。用 Google / GitHub 注册的账号压根没有密码——那一句与「密码不对」是同一句话，所以底下那行
 * 「没设过、或忘了？用邮箱验证码重设」两种都接住（手机那一份同一个口径，mobile/src/me/PasswordDialog.tsx）。
 */
function PasswordDialog({ onClose }: { onClose: () => void }) {
  const email = useChat((s) => s.myProfile?.email || s.account.email);
  const signInWithPassword = useChat((s) => s.signInWithPassword);
  const updatePassword = useChat((s) => s.updatePassword);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const problem = passwordProblem(cur, next, again);
  const ready = passwordReady(cur, next, again) && !busy;

  const save = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const okCur = await signInWithPassword(email, cur, true);
    if (!okCur) {
      setBusy(false);
      setError("现在的密码不对（用 Google / GitHub 注册的账号没有密码，走下面那行）");
      return;
    }
    const ok = await updatePassword(next);
    setBusy(false);
    if (!ok) {
      setError(useChat.getState().error ?? "没有改成，稍后再试");
      return;
    }
    onClose();
    toast("密码改好了");
  };

  if (forgot) return <ForgotPasswordDialog initialEmail={email} onClose={onClose} />;

  const line = error ?? (problem !== "" ? problem : null);
  return (
    <Shell
      title="改密码"
      desc="新密码至少 8 位。"
      onClose={onClose}
      locked={busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={!ready} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <Input type="password" autoComplete="current-password" autoFocus placeholder="现在的密码" aria-label="现在的密码" value={cur} onChange={(e) => setCur(e.target.value)} />
        <Input type="password" autoComplete="new-password" placeholder="新密码" aria-label="新密码" value={next} onChange={(e) => setNext(e.target.value)} />
        <Input
          type="password"
          autoComplete="new-password"
          placeholder="再输一遍新密码"
          aria-label="再输一遍新密码"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void save();
            }
          }}
        />
      </div>
      <p role="alert" className="min-h-[18px] text-[12px] text-err">{line ?? ""}</p>
      <button
        type="button"
        onClick={() => setForgot(true)}
        className="-mt-2 self-start text-[12.5px] text-brand underline-offset-2 hover:underline"
      >
        没设过、或忘了现在的密码？用邮箱验证码重设
      </button>
    </Shell>
  );
}

// ── 换形象 ───────────────────────────────────────────────────────────

function FaceDialog({ spec, onClose }: { spec: FaceSpec; onClose: () => void }) {
  const [slot, setSlot] = useState(spec.current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (): Promise<void> => {
    if (busy) return;
    if (slot === spec.current) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    const r = await spec.onSave(slot);
    setBusy(false);
    if (r !== null) {
      setError(r);
      return;
    }
    onClose();
  };
  return (
    <Shell
      title={spec.title}
      desc="脸是它在通讯录、聊天里的样子。"
      onClose={onClose}
      locked={busy}
      wide
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </Button>
        </>
      }
    >
      <div className="flex justify-center pt-1">
        <WxFace slot={slot} size={88} state="alive" />
      </div>
      <FaceWall selected={slot} onPick={(f) => setSlot(f.slot)} />
      <ErrorLine text={error} />
    </Shell>
  );
}
