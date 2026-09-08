// cloudExport（#1117）：云会话头部那颗「导出」装出来的那份文件。
// 钉三件事：文件名形状（下载目录里分得清是谁、是哪次导出）、jsonl 逐行
// 无损往返（分析脚本读回来的每一条必须就是日志里的那一条）、空日志的退化形。
import { describe, expect, it } from "vitest";
import { buildCloudLogExport, cloudLogFilename } from "../../src/renderer/src/lib/cloudExport.js";
import type { SessionEvent } from "../../src/session/events.js";

const ev = (seq: number): SessionEvent =>
  ({ type: "chat_message", seq, ts: 1700000000000 + seq, fromUid: "u1", label: "小明", text: `第 ${seq} 句` }) as unknown as SessionEvent;

describe("cloudLogFilename", () => {
  it("otto-cloud-<id前8位>-<本地时间戳>.jsonl", () => {
    expect(cloudLogFilename("abcdef1234567890", 1700000000000)).toMatch(
      /^otto-cloud-abcdef12-\d{8}-\d{6}\.jsonl$/
    );
  });

  it("空 id 退成 session（文件名不能开不了头）", () => {
    expect(cloudLogFilename("", 1700000000000)).toMatch(/^otto-cloud-session-\d{8}-\d{6}\.jsonl$/);
  });
});

describe("buildCloudLogExport", () => {
  it("一行一条原始事件，逐行解析回来逐条相等（无损是这份文件存在的全部理由）", () => {
    const events = [ev(1), ev(2), ev(3)];
    const file = buildCloudLogExport({ sessionId: "s-abc", events, exportedTs: 1700000000000 });
    expect(file.mime).toBe("application/x-ndjson");
    const lines = file.text.split("\n");
    expect(lines.at(-1)).toBe(""); // 末行换行结尾
    expect(lines.slice(0, -1).map((l) => JSON.parse(l))).toEqual(events);
  });

  it("零事件 = 空文件（按钮那侧另有 disabled 挡着，这里钉住退化形不报错）", () => {
    const file = buildCloudLogExport({ sessionId: "s-abc", events: [], exportedTs: 1700000000000 });
    expect(file.text).toBe("");
  });
});
