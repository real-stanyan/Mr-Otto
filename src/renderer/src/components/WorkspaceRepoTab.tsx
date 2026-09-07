// WorkspaceRepoTab —— 工作区设置页的「仓库」tab（#991，ADR-0234）。
//
// 仓库是**工作区**的属性，不是某一条会话的：原来它挂在云会话头部的「配置仓库…」
// 弹窗里，走会话房的 config 帧——得先开着一条这个工作区的云会话才配得了，而且
// 会话头部常驻一格「未配仓库」，对文案类工作区（压根没有仓库）是句噪音。现在
// 走控制房 RPC（workspaceRepoState / workspaceRepoConfig），从侧栏 ⚙ 进来就能配。
//
// 文案要说清「不是每个工作区都需要仓库」——留空是一个正当的状态，不是没配完。
// PAT 纪律照抄 ProviderKeyDialog 的不变量原话："输入框存完即清，渲染层不留 key
// 的任何副本；状态只有布尔"。token 栏永远是空的：服务端只回 hasPat，token 不下行。
// 「清除已存的 token」是显式开关：地址栏预填了、密码框天生是空的，owner 顺手改个
// 地址就把私有仓库的凭据清了，下次 clone 静默失败——三态因此是：省略 = 不动，
// `""` = 清除（只有这个开关能产生），非空 = 换新。
// 错误落本地状态，不落 workspaceGroupsError：那一格是整页共用的，这一页刚打开那
// 一刻可能还留着一条跟仓库毫不相干的旧错误。

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useChat } from "../store.js";
import { repoStatusText } from "../lib/cloudRepoStatus.js";
import { modelStatusText } from "../lib/cloudModelStatus.js";
import { EMBEDDED_CREDENTIAL_MESSAGE, repoUrlHasEmbeddedCredential } from "../lib/cloudRepoUrl.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { CloudWorkspaceState } from "../../../shared/shellBridge.js";

const SECTION_LABEL = "text-[11px] tracking-[0.06em] text-muted-foreground uppercase";

type Loaded =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ok"; value: CloudWorkspaceState };

export function WorkspaceRepoTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
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
  const modelStatus = modelStatusText(state.kind === "ok" ? state.value.modelRoute : null);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[12px] text-muted-foreground">
        水獭在这个仓库的工作副本里干活。<strong className="font-medium text-foreground">不是每个工作区都需要仓库</strong>
        ——做文案、运营这类活留空就行，水獭在一个空目录里干。模型不用配：统一走所有者的订阅额度。
      </p>

      <section className="flex flex-col gap-1.5">
        <p className={SECTION_LABEL}>现状</p>
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
            {/* 模型那一行同头部那一格（#1052，ADR-0246）：**只在起不了 turn 的时候出现**。
                正常态这一页上半那段正文已经说了「模型不用配：统一走所有者的订阅额度」，
                再列一行「某某款 · 托管」既重复又不保真——那是工作区默认款，真跑一轮
                按 agent 白名单/Auto 现取 */}
            {modelStatus && (
              <>
                <dt className="text-muted-foreground">模型</dt>
                <dd className="text-err" title={modelStatus.full}>{modelStatus.short}</dd>
              </>
            )}
            {repo?.clone && (
              <>
                <dt className="text-muted-foreground">最近一次</dt>
                <dd className="min-w-0 break-words">{repo.clone.text}</dd>
              </>
            )}
          </dl>
        )}
      </section>

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
    </div>
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
    <section className="flex flex-col gap-[10px]">
      <p className={SECTION_LABEL}>配置</p>
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
    </section>
  );
}
