// WorkspaceSessionsTab —— 工作区设置里的「会话」那一页（#1120 从 WorkspacePage 抽出，
// 顺带修 #1115）。
//
// ## #1115：这一页原来对着两条活着的云会话说「还没有人发布会话」
//
// 两处判据严格互补、读的是同一份 `cloudSessionList[ws.id]`：侧栏 `.filter(r => !r.archived)`
// 取活着的，这一页 `.filter(r => r.archived)` 取归档的、一条都没有时整节不画。于是
// **最常见的情形**——有会话、都没归档——这一屏是空白，而它叫「会话」，还是点 ⚙ 落地的
// 第一格。当初的理由（「活着的那些在侧栏，这里只是归档的去处」，ADR-0217「入口留两个
// 只会让人以为它们是两样东西」）成立不代表代价付了：同一个判据 #1056 已经下过一次——
// **一个叫「文件」却一个文件都列不出来的页面是 #722 撒谎的勾的近亲**。
//
// 所以这一页列**全部**云会话，进行中的排在归档的上面（`cloudSessionRows` 本来就这么排）。
// 侧栏那份不动：那边是「我现在要进哪条」，这边是「这个工作区有哪些」。
//
// ## 「读不到」与「一条都没有」分家
//
// `refreshCloudSessions` 失败时只写 `workspaceGroupsError`、不动 `cloudSessionList`，
// 于是这一页原来的 `?? EMPTY` 把两件事压成了同一个观测。判据改成 `undefined` vs `[]`
// （同 gitHosts 那份 `null` vs `[]`）：**没有那一格 = 从来没成功读到过**，配一句
// 「读不到」加一颗重试；`[]` 才是「这个工作区还没有云会话」。中间还要一档 `loading`，
// 否则刚挂载那一帧会对着「还没拉过」喊读不到。

import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { InsetEmpty, InsetGroup, InsetLabel, InsetNote, InsetRow } from "@/components/ui/inset-list.js";
import { useChat } from "../store.js";
import { cloudSessionRows, sessionRows } from "../lib/workspaceView.js";
import { formatProxyTime } from "../lib/proxyShare.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export function WorkspaceSessionsTab({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  return (
    <div className="flex flex-col">
      <CloudSessionsSection ws={ws} selfUid={selfUid} />
      <PublishedSection ws={ws} selfUid={selfUid} />
    </div>
  );
}

/** 云会话：这个工作区里**全部**的，进行中排在归档上面（#1115） */
function CloudSessionsSection({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  // `undefined` = 从来没成功读到过（还没拉 / 拉失败），`[]` = 确实一条都没有
  const list = useChat((s) => s.cloudSessionList[ws.id]);
  const refresh = useChat((s) => s.refreshCloudSessions);
  const openCloud = useChat((s) => s.openCloudSession);
  const deleteCloud = useChat((s) => s.cloudDelete);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void refresh(ws.id).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ws.id, refresh]);

  const rows = list === undefined ? [] : cloudSessionRows(list, ws);

  return (
    <>
      <InsetLabel className="pt-0">云会话</InsetLabel>
      {loading && list === undefined ? (
        <InsetGroup><InsetEmpty title="正在读这个工作区的会话…" /></InsetGroup>
      ) : list === undefined ? (
        // 读不到 ≠ 里面是空的（同 ADR-0243/0251）：说成后者会让人以为群里什么都没发生过
        <InsetGroup>
          <InsetEmpty
            title="读不到这个工作区的会话"
            hint="可能是网络，也可能是云端暂时不可用。它们没有丢——重试一次就回来了。"
          />
          <InsetRow title="再试一次" tone="action" onClick={() => void refresh(ws.id)} />
        </InsetGroup>
      ) : rows.length === 0 ? (
        <InsetGroup>
          <InsetEmpty
            title="还没有云会话"
            hint="在侧栏「工作区」那一栏，这个工作区的组头上点 ＋ 就能开一条。"
          />
        </InsetGroup>
      ) : (
        <InsetGroup>
          {rows.map((row) => (
            <InsetRow
              key={row.id}
              title={row.title}
              subtitle={`${row.creatorLabel} · ${formatProxyTime(row.updatedTs)}`}
              onClick={() => void openCloud(ws.id, row.id)}
              trailing={
                <>
                  {row.archived && <span className="rounded-[5px] bg-foreground/[0.09] px-[6px] py-[3px] text-[10px] leading-none">已归档</span>}
                  {(selfUid === ws.ownerUid || selfUid === row.creatorUid) && (
                    <Button
                      variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-err"
                      aria-label={`彻底删除「${row.title}」`}
                      title="彻底删除这条会话（整段对话从云端抹掉，不可恢复）"
                      onClick={(e) => {
                        e.stopPropagation();   // 行本身是「打开」，这颗钮不该顺带把它打开
                        if (!window.confirm(`彻底删除「${row.title}」？\n整段对话会从云端抹掉，群里所有人都再也看不到，不可恢复。`)) return;
                        void deleteCloud(ws.id, row.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  )}
                </>
              }
              chevron
            />
          ))}
        </InsetGroup>
      )}
      <InsetNote>
        点一行进去看。<b className="font-medium text-foreground">归档的只能看不能续</b>——云端没有「取消归档」；
        删除会把整段对话从云端抹掉，群里所有人都看不到。
      </InsetNote>
    </>
  );
}

/** 已发布会话：一次性快照，导入即 fork 成本机新会话——与云会话是两样东西，分两组 */
function PublishedSection({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const importSession = useChat((s) => s.importWorkspaceSession);
  const unpublish = useChat((s) => s.unpublishWorkspaceSession);
  const rows = sessionRows(ws);

  return (
    <>
      <InsetLabel>已发布会话</InsetLabel>
      {rows.length === 0 ? (
        <InsetGroup>
          <InsetEmpty
            title="还没有人发布会话到这里"
            hint="在一条本地会话的「⋯」里选「发布到工作区」，成员就能把它整段导入。"
          />
        </InsetGroup>
      ) : (
        <InsetGroup>
          {rows.map((row) => {
            const raw = ws.sessions.find((s) => s.id === row.id)!;
            return (
              <InsetRow
                key={row.id}
                title={row.title}
                subtitle={`${row.publisherLabel} · ${formatProxyTime(row.updatedTs)}`}
                onClick={() => void importSession(raw.publisherUid, raw.pkgId)}
                trailing={
                  raw.publisherUid === selfUid ? (
                    <Button
                      variant="ghost" size="xs" className="text-err"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm(`撤回会话「${row.title}」？其他成员将不能再导入它。`)) {
                          void unpublish(ws.id, row.id);
                        }
                      }}
                    >
                      撤回
                    </Button>
                  ) : null
                }
              />
            );
          })}
        </InsetGroup>
      )}
      <InsetNote>
        点一行 = 整段导入到本机。<b className="font-medium text-foreground">发布出去的是快照</b>：
        导入之后两边各走各的，谁也改不了谁。
      </InsetNote>
    </>
  );
}
