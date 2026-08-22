// 记忆条目的 prompt-injection 粗筛。对标 hermes tools/threat_patterns.py 的 strict 档。
// 写入时拒、注入时屏蔽——两道都过：写入时漏网的（规则后来才加的）注入时还能拦。
// 是粗筛不是防线：目标是"别让一条被污染的记忆静悄悄指挥以后的每个 session"。

const RULES: { name: string; re: RegExp }[] = [
  { name: "instruction-override", re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)|忽略(之前|以上|先前|此前)(的)?(所有|全部)?(指令|提示|规则)/i },
  { name: "fake-role-tag", re: /<\/?\s*(system|assistant|developer|tool)\s*>|\[(SYSTEM|INST)\]/i },
  { name: "pipe-to-shell", re: /(curl|wget)\s[^|\n]*\|\s*(ba|z|)sh\b/i },
  { name: "persona-hijack", re: /you are now\s+(a|an|the)?\s*\w+|从现在开始你是|你现在是一个/i },
  { name: "exfiltration", re: /(send|post|upload|发送|上传)[^\n]{0,40}(api[_ ]?key|token|password|密码|密钥)/i },
];

export function scanThreat(text: string): string | null {
  for (const r of RULES) if (r.re.test(text)) return r.name;
  return null;
}

export function sanitizeForPrompt(entries: string[]): string[] {
  return entries.map((e) => {
    const hit = scanThreat(e);
    return hit ? `[BLOCKED: ${hit} — 这条记忆含可疑指令，已在注入时屏蔽，请在设置页检查]` : e;
  });
}
