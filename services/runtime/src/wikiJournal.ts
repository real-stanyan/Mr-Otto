// wikiJournal —— wiki 的追加式备份 + 历史（#1140，spec §6）。**单向：文件是事实，journal 是备份。**
// 不做双向同步、不做对账；恢复只发生在 wiki/ 不存在时（wikiService.ensure）。
// 写方只有 runtime（service key）；客户端没有 insert/delete 策略（0033）。

import type { SupabaseClient } from "@supabase/supabase-js";

export type WikiJournalKind = "write" | "remove" | "edit" | "migrate" | "restore" | "seed" | "external";
export type WikiAuthorKind = "agent" | "member" | "system" | "external";
export interface WikiJournalEntry {
  path: string;
  /** null = 这一版是「删掉了」 */
  content: string | null;
  kind: WikiJournalKind;
  authorKind: WikiAuthorKind;
  authorId: string;
  /** 写入那一刻的名字（快照，改名不回写，同 ADR-0256） */
  authorLabel: string;
}
export interface WikiJournal {
  append(workspaceId: string, entry: WikiJournalEntry): Promise<void>;
  /** 每条路径的最新版本。第一版「按 seq 倒序全拉、首见即头」——行数 = 写入次数，量级变了见 spec §14 */
  heads(workspaceId: string): Promise<Map<string, { content: string | null; seq: number }>>;
}

export function createInMemoryWikiJournal(): WikiJournal & { rows: (WikiJournalEntry & { workspaceId: string; seq: number })[] } {
  const rows: (WikiJournalEntry & { workspaceId: string; seq: number })[] = [];
  return {
    rows,
    async append(workspaceId, entry) {
      rows.push({ ...entry, workspaceId, seq: rows.length + 1 });
    },
    async heads(workspaceId) {
      const out = new Map<string, { content: string | null; seq: number }>();
      for (const r of [...rows].reverse()) {
        if (r.workspaceId !== workspaceId || out.has(r.path)) continue;
        out.set(r.path, { content: r.content, seq: r.seq });
      }
      return out;
    },
  };
}

const TABLE = "workspace_wiki_journal";

export function createSupabaseWikiJournal(client: SupabaseClient): WikiJournal {
  return {
    async append(workspaceId, entry) {
      const { error } = await client.from(TABLE).insert({
        workspace_id: workspaceId,
        path: entry.path,
        content: entry.content,
        kind: entry.kind,
        author_kind: entry.authorKind,
        author_id: entry.authorId,
        author_label: entry.authorLabel,
      });
      if (error) throw new Error(`${TABLE} 写入失败：${error.message}`);
    },
    async heads(workspaceId) {
      const { data, error } = await client.from(TABLE).select("path,content,seq").eq("workspace_id", workspaceId).order("seq", { ascending: false });
      if (error) throw new Error(`${TABLE} 读取失败：${error.message}`);
      const out = new Map<string, { content: string | null; seq: number }>();
      for (const r of (data ?? []) as { path: string; content: string | null; seq: number }[]) {
        if (!out.has(r.path)) out.set(r.path, { content: r.content, seq: r.seq });
      }
      return out;
    },
  };
}
