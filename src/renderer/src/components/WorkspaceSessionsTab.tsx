// WorkspaceSessionsTab —— 工作区设置里的「会话」那一页（#1120 从 WorkspacePage 抽出，
// 修 #1115；四条判断是从 PR #1116 捞回来的，见文件末尾那段）。
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
// 所以这一页列**全部**云会话。重复的代价用**分工**抵掉：这一页回答「有哪些」，
// **动作各在各家**——活着那几条的归档/删除只在侧栏那颗 ⋮，这一页只读、点进去打开；
// 归档那几条的 🗑 只在这一页（ADR-0245：删除的入口不能只有侧栏那个 ⋮，而**归档掉的
// 才是最想清掉的那批**、它们根本不在侧栏里）。
//
// ## 「读不到」与「一条都没有」分家
//
// `refreshCloudSessions` 失败时只写 `workspaceGroupsError`、**不动** `cloudSessionList`
// （那是对的——「拿不到」≠「被清空」，同 ADR-0197 grants 缓存的规矩）。于是三态的判据是
// 「这一趟拉完了没有」+「拉完之后这一格有没有值」：`loaded && list === undefined` 只可能
// 是失败。**改完之后空态开始承载断言，所以这一分家是必须的**，不是洁癖。

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

function CloudSessionsSection({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  // `undefined` = 这一格从来没被成功写过（还没拉 / 拉失败），`[]` = 确实一条都没有
  const list = useChat((s) => s.cloudSessionList[ws.id]);
  const refresh = useChat((s) => s.refreshCloudSessions);
  const openCloud = useChat((s) => s.openCloudSession);
  const deleteCloud = useChat((s) => s.cloudDelete);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    // refresh 自己吞掉失败（写进 workspaceGroupsError），所以它永远 resolve；
    // 「成功了没有」只能看它有没有往 cloudSessionList 里写这一格
    void refresh(ws.id).then(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [ws.id, refresh]);

  const all = list === undefined ? [] : cloudSessionRows(list, ws);
  const live = all.filter((r) => !r.archived);
  const archived = all.filter((r) => r.archived);
  const canDelete = (creatorUid: string): boolean => selfUid === ws.ownerUid || selfUid === creatorUid;

  return (
    <>
      <InsetLabel className="pt-0">云会话</InsetLabel>
      {!loaded && list === undefined ? (
        // 还没拉完：说「正在读」，不说「一条都没有」——这一页是点进来的，
        // 一进来就一片空白比一句「正在读」更像坏了
        <InsetGroup><InsetEmpty title="正在读这个工作区的会话…" /></InsetGroup>
      ) : list === undefined ? (
        // 读不到 ≠ 里面是空的（同 ADR-0243/0251）：说成后者会让人以为群里什么都没发生过
        <InsetGroup>
          <InsetEmpty
            title="读不到云会话清单"
            hint="可能是网络，也可能是云端暂时不可用。它们没有丢——重试一次就回来了。"
          />
          <InsetRow title="再试一次" tone="action" onClick={() => void refresh(ws.id)} />
        </InsetGroup>
      ) : live.length === 0 ? (
        <InsetGroup>
          <InsetEmpty
            title="还没有进行中的云会话"
            hint="在侧栏「工作区」那一栏，这个工作区的组头上点 ＋ 就能开一条。"
          />
        </InsetGroup>
      ) : (
        <InsetGroup>
          {live.map((row) => (
            <InsetRow
              key={row.id}
              title={row.title}
              subtitle={`${row.creatorLabel} · ${formatProxyTime(row.updatedTs)}`}
              chevron
              onClick={() => void openCloud(ws.id, row.id)}
            />
          ))}
        </InsetGroup>
      )}

      {/* 归档那一节：**一条都没有就整节不出**——不为一件没发生过的事留一行空态。
          能这么收是因为上面那节常驻且自带空态，这一页不会整个空掉 */}
      {archived.length > 0 && (
        <>
          <InsetLabel>已归档的云会话</InsetLabel>
          <InsetGroup>
            {archived.map((row) => (
              <InsetRow
                key={row.id}
                title={row.title}
                subtitle={`${row.creatorLabel} · ${formatProxyTime(row.updatedTs)}`}
                chevron
                onClick={() => void openCloud(ws.id, row.id)}
                trailing={
                  canDelete(row.creatorUid) ? (
                    <Button
                      variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-err"
                      aria-label={`彻底删除「${row.title}」`}
                      title="彻底删除这条会话（整段对话从云端抹掉，不可恢复）"
                      onClick={() => {
                        if (!window.confirm(`彻底删除「${row.title}」？\n整段对话会从云端抹掉，群里所有人都再也看不到，不可恢复。`)) return;
                        void deleteCloud(ws.id, row.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  ) : null
                }
              />
            ))}
          </InsetGroup>
          <InsetNote>
            归档的<b className="font-medium text-foreground">只能看不能续</b>——云端没有「取消归档」。
            删除会把整段对话从云端抹掉，群里所有人都看不到。
          </InsetNote>
        </>
      )}
    </>
  );
}

/** 已发布会话：一次性快照包，从会话头部「更多」→「发布到工作区…」放上来（ADR-0198
    切片 3）——与云会话是两样东西，分开一组。

    **一份都没发布过时整节不出**（#1115 / PR #1116）：原来它在空的时候画一句「还没有
    人发布会话到这个工作区」，与紧邻那节自己写着的规矩（「不该为一件没发生过的事留一行
    空态」）矛盾；而一个没发布过、没归档过的工作区因此顶着一句与它无关的话当唯一内容。
    能这么收是因为云会话那节常驻且自带空态。代价：这一页不再教人「怎么发布」——
    而发布的入口本来就不在这一页，在会话的「更多」菜单里。 */
function PublishedSection({ ws, selfUid }: { ws: WorkspaceSnapshot; selfUid: string }) {
  const importSession = useChat((s) => s.importWorkspaceSession);
  const unpublish = useChat((s) => s.unpublishWorkspaceSession);
  const rows = sessionRows(ws);
  if (rows.length === 0) return null;

  return (
    <>
      <InsetLabel>已发布会话</InsetLabel>
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
                    onClick={() => {
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
      <InsetNote>
        点一行 = 整段导入到本机。<b className="font-medium text-foreground">发布出去的是快照</b>：
        导入之后两边各走各的，谁也改不了谁。
      </InsetNote>
    </>
  );
}
