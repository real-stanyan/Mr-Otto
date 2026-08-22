// 记忆条目的 prompt-injection 粗筛。对标 hermes tools/threat_patterns.py 的 strict 档。
// 写入时拒、注入时屏蔽——两道都过：写入时漏网的（规则后来才加的）注入时还能拦。
// 是粗筛不是防线：目标是"别让一条被污染的记忆静悄悄指挥以后的每个 session"。

const RULES: { name: string; re: RegExp }[] = [
  { name: "instruction-override", re: /(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)|忽略(之前|以上|先前|此前)(的)?(所有|全部)?(指令|提示|规则)/i },
  { name: "fake-role-tag", re: /<\/?\s*(system|assistant|developer|tool)\s*>|\[(SYSTEM|INST)\]/i },
  { name: "pipe-to-shell", re: /(curl|wget)\s[^|\n]*\|\s*(ba|z|)sh\b/i },
  { name: "persona-hijack", re: /\b(you are now|from now on you are|act as)\s+(a |an |the )?(?:unrestricted|jailbroken|uncensored|DAN|evil|free)\b|\bwithout (any )?(restrictions|limits|rules|filters)\b|(从现在开始|现在起)你是(一个)?(没有|无)(任何)?(限制|规则|过滤)|你现在是一个(没有|无)(任何)?(限制|规则)/i },
  { name: "exfiltration", re: /(?:\b(?:send(?:ing|s)?|sent|post(?:ed|ing|s)?|upload(?:ed|ing|s)?)\b|发送|上传)[^\n]{0,40}(api[_ ]?key|token|password|密码|密钥)/i },
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
