// WorkspaceFilesTab —— 工作区设置页的「文件」tab（#1056，ADR 见下；前身是
// 「仓库」tab，#991 / ADR-0234 把它从云会话头部搬到这里）。
//
// **这一页的主语是「水獭在哪儿干活」，不是「Git 地址填什么」。** 每个工作区都有
// 一个共用工作文件夹（一容器一卷，ADR-0232），这跟你是不是程序员无关；Git 仓库
// 只是往那个文件夹里装东西的一种方式，而且是此前唯一做出来的一种。上一版把这唯一
// 一种来源当成了页面本身的身份，于是：tab 叫「仓库」（非程序员读到的第一个词就跟
// 自己无关）、正文第一句在解释「你可能用不到这一页」（一页要先说服你它可能与你无关，
// 就是定义错了）、空目录写成「未配仓库」（一个正当状态被写成缺一格配置）。
//
// 所以顺序是：先画文件夹里有什么，Git 收成下面一节可选的「来源」。**列得出内容是
// 这次改名成立的前提**——一个叫「文件」却一个文件都列不出来的页面，是 #722「撒谎的
// 勾」的近亲。
//
// PAT 纪律照抄 ProviderKeyDialog 的不变量原话："输入框存完即清，渲染层不留 key
// 的任何副本；状态只有布尔"。token 栏永远是空的：服务端只回 hasPat，token 不下行。
// 「清除已存的 token」是显式开关：地址栏预填了、密码框天生是空的，owner 顺手改个
// 地址就把私有仓库的凭据清了，下次 clone 静默失败——三态因此是：省略 = 不动，
// `""` = 清除（只有这个开关能产生），非空 = 换新。
// 错误落本地状态，不落 workspaceGroupsError：那一格是整页共用的，这一页刚打开那
// 一刻可能还留着一条跟这里毫不相干的旧错误。

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, Link2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useChat } from "../store.js";
import { repoStatusText } from "../lib/cloudRepoStatus.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";
import { EMBEDDED_CREDENTIAL_MESSAGE, repoUrlHasEmbeddedCredential } from "../lib/cloudRepoUrl.js";
import {
  entryMeta,
  workCrumbs,
  workFileNotice,
  workFolderNotice,
} from "../lib/workFilesView.js";
import { joinWorkPath } from "../../../shared/remote/workPath.js";
import type { CsWorkNode } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudWorkspaceState } from "../../../shared/shellBridge.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; value: CloudWorkspaceState };

export function WorkspaceFilesTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const load = useChat((s) => s.workspaceRepoState);
  const save = useChat((s) => s.workspaceRepoConfig);
  const isOwner = ws.ownerUid === selfUid;
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ kind: "loading" });
    void load(ws.id).then((r) => {
      if (!alive) return;
      setState(r.ok ? { kind: "ok", value: r.value } : { kind: "error", message: r.message });
    });
    return () => {
      alive = false;
    };
  }, [ws.id, load, reloadTick]);

  const repo = state.kind === "ok" ? state.value.repo : null;
  const repoStatus = repoStatusText(repo);
  // 起不了 turn 这件事仍然在这一页说一次（ADR-0246 的判据原样：只在起不了 turn
  // 的时候出现）。它跟文件无关，摆在最上面是因为**这一页是它在会话界面之外唯一
  // 的落点**——真正该住的地方是页头（跨 tab 可见），那要给设置页每次打开都加一次
  // 控制房 RPC，留给以后
  const modelStatus = modelStatusText(state.kind === "ok" ? state.value.modelRoute : null);

  return (
    <div className="flex flex-col gap-5">
      {modelStatus && (
        // 这一页有的是地方，写整句——`short` 是给会话头部那一格 150px 用的
        <p className="text-xs text-err">{modelStatus.full}</p>
      )}

      <WorkFolder workspaceId={ws.id} />

      <section className="flex flex-col gap-[10px] border-t border-border pt-4">
        <p className={SECTION_LABEL}>从 Git 仓库带一份代码进来（可选）</p>
        <p className="text-[12px] text-muted-foreground">
          配了仓库，水獭就在它的一份工作副本里干活。
          <strong className="font-medium text-foreground">不是每个工作区都需要仓库</strong>
          ——做文案、运营这类活留空就行。
        </p>

        {state.kind === "loading" ? (
          <p className="text-xs text-muted-foreground">正在读取…</p>
        ) : state.kind === "error" ? (
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-err">{state.message}</p>
            <Button variant="ghost" size="xs" onClick={() => setReloadTick((t) => t + 1)}>
              重试
            </Button>
          </div>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">仓库</dt>
            <dd className="min-w-0 break-all" title={repoStatus.full}>{repoStatus.short}</dd>
            {repo?.clone && (
              <>
                <dt className="text-muted-foreground">最近一次</dt>
                <dd className="min-w-0 break-words">{repo.clone.text}</dd>
              </>
            )}
          </dl>
        )}

        {isOwner ? (
          <RepoForm
            key={ws.id}
            repo={repo}
            disabled={state.kind !== "ok"}
            onSave={async (patch) => {
              const r = await save(ws.id, patch);
              if (r.ok) setState({ kind: "ok", value: r.value });
              return r;
            }}
          />
        ) : (
          <p className="text-[11px] text-muted-foreground">只有所有者能改仓库配置。</p>
        )}
      </section>
    </div>
  );
}

// ─── 工作文件夹浏览 ────────────────────────────────────────────────────
/** 翻工作文件夹。**读不到 ≠ 里面是空的**（同 ADR-0243 那条三态纪律），所以
    出错时上一份内容留在原地、错误另起一行说——把清单清空会让人以为水獭做的
    东西没了。 */
function WorkFolder({ workspaceId }: { workspaceId: string }) {
  const loadFiles = useChat((s) => s.workspaceFiles);
  const [path, setPath] = useState("");
  const [node, setNode] = useState<CsWorkNode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 点得快时旧答复会后到（子目录大、根目录小）。序号一比就知道该不该采信——
  // 没有它的话，列表会在你已经翻进去之后自己跳回上一层
  const reqSeq = useRef(0);
  const [now] = useState(() => Date.now());

  const open = useCallback(
    async (next: string): Promise<void> => {
      const id = ++reqSeq.current;
      setBusy(true);
      const r = await loadFiles(workspaceId, next);
      if (id !== reqSeq.current) return;
      setBusy(false);
      if (!r.ok) {
        setError(r.message);
        return;
      }
      setError(null);
      setPath(next);
      setNode(r.value);
    },
    [workspaceId, loadFiles],
  );

  useEffect(() => {
    void open("");
  }, [open]);

  const crumbs = workCrumbs(path);
  const notice = node ? workFolderNotice(node) : null;
  const fileNotice = node ? workFileNotice(node) : null;

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <p className={SECTION_LABEL}>工作文件夹</p>
        <button
          type="button"
          className="text-muted-foreground transition-colors duration-150 ease-out hover:text-foreground disabled:opacity-40"
          title="重新读取"
          disabled={busy}
          onClick={() => void open(path)}
        >
          <RotateCw className={`size-3 ${busy ? "animate-spin" : ""}`} />
        </button>
      </div>

      <p className="text-[12px] text-muted-foreground">
        水獭在这个文件夹里干活，做出来的东西都留在这儿。同一个工作区的所有会话共用这一份。
      </p>

      <nav className="flex min-w-0 flex-wrap items-center gap-0.5 text-xs">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={c.path} className="flex min-w-0 items-center gap-0.5">
              {i > 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              {last ? (
                <span className="truncate font-medium">{c.name}</span>
              ) : (
                <button
                  type="button"
                  className="truncate text-muted-foreground underline-offset-2 transition-colors duration-150 ease-out hover:text-foreground hover:underline"
                  onClick={() => void open(c.path)}
                >
                  {c.name}
                </button>
              )}
            </span>
          );
        })}
      </nav>

      <div className={`min-w-0 transition-opacity duration-150 ease-out ${busy ? "opacity-50" : ""}`}>
        {node === null ? (
          // 第一次就没读到时说的是「读不到」不是「正在读取」——后者会让人一直等
          <p className="px-1 py-2 text-xs text-muted-foreground">{error === null ? "正在读取…" : "读不到工作文件夹。"}</p>
        ) : notice ? (
          <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            {notice}
          </p>
        ) : node.kind === "dir" ? (
          <ul className="min-w-0 rounded-md border border-border">
            {node.entries.map((e) => (
              <li key={e.name} className="border-b border-border last:border-b-0">
                <button
                  type="button"
                  className="flex w-full min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-accent"
                  onClick={() => void open(joinWorkPath(path, e.name))}
                >
                  {e.kind === "dir" ? (
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : e.kind === "other" ? (
                    <Link2 className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <File className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{e.name}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{entryMeta(e, now)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <pre className="max-h-[360px] overflow-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
            {node.kind === "file" ? node.text : ""}
          </pre>
        )}
      </div>

      {node?.kind === "dir" && node.truncated && (
        <p className="text-[11px] text-muted-foreground">这个目录里的东西太多，只列了一部分。</p>
      )}
      {fileNotice && <p className="text-[11px] text-muted-foreground">{fileNotice}</p>}
      {error && <p className="text-xs text-err">{error}</p>}
    </section>
  );
}

function RepoForm({
  repo,
  disabled,
  onSave,
}: {
  repo: CloudWorkspaceState["repo"];
  disabled: boolean;
  onSave: (patch: { repoUrl?: string; pat?: string }) => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const [repoUrl, setRepoUrl] = useState(repo?.url ?? "");
  const [pat, setPat] = useState("");
  const [clearPat, setClearPat] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // 服务端那份地址到了（首次读取 / 保存回执）就用它预填：预填的是服务端刚说的
  // 事实，不是本地草稿（#834）。人正在打字时不覆盖——只在 repo.url 变化时同步
  useEffect(() => {
    setRepoUrl(repo?.url ?? "");
  }, [repo?.url]);

  const url = repoUrl.trim();
  const dirty = url !== (repo?.url ?? "") || pat.trim() !== "" || clearPat;

  const submit = async (): Promise<void> => {
    if (busy || !dirty) return;
    if (url !== "" && repoUrlHasEmbeddedCredential(url)) {
      setError(EMBEDDED_CREDENTIAL_MESSAGE);
      return;
    }
    setError(null);
    setBusy(true);
    const patch: { repoUrl?: string; pat?: string } = {};
    if (url !== "" && url !== (repo?.url ?? "")) patch.repoUrl = url;
    // 三态：清除 > 新值 > 不动
    const typed = pat.trim();
    if (clearPat) patch.pat = "";
    else if (typed !== "") patch.pat = typed;
    if (patch.repoUrl === undefined && patch.pat === undefined) {
      setBusy(false);
      setError(url === "" && (repo?.url ?? "") !== "" ? "要撤掉仓库的话把地址改成别的；这一版还不支持清空。" : "没有要保存的内容。");
      return;
    }
    const r = await onSave(patch);
    setBusy(false);
    if (r.ok) {
      setPat(""); // 存完即清
      setClearPat(false);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } else {
      setError(r.message);
    }
  };

  return (
    <div className="flex flex-col gap-[10px]">
      <Input
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || busy}
        className="font-mono text-[13px]"
        placeholder="https://github.com/x/y.git（留空 = 不用仓库）"
        value={repoUrl}
        onChange={(e) => { setRepoUrl(e.target.value); setError(null); }}
      />
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled || busy || clearPat}
        className="font-mono text-[13px]"
        placeholder={repo?.hasPat ? "已存了一个 token（留空 = 不改动）" : "Personal Access Token（可选，私有仓库需要）"}
        value={pat}
        onChange={(e) => setPat(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground">
        私有仓库的 token 请填在这一栏——不要拼进上面的仓库地址。保存不会立刻触发 clone，要等下一次工具调用。
      </p>
      {repo?.hasPat && (
        <button
          type="button"
          className="w-fit text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            setClearPat((v) => !v);
            setPat("");
          }}
        >
          {clearPat ? "取消清除（保留已存的 token）" : "清除已存的 token"}
        </button>
      )}
      {error && <p className="text-xs text-err">{error}</p>}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={disabled || busy || !dirty} onClick={() => void submit()}>
          {busy ? "保存中…" : saved ? "已保存" : "保存"}
        </Button>
      </div>
    </div>
  );
}
