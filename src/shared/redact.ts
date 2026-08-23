// 喂给摘要模型之前的脱敏。对标 hermes redact_sensitive_text(force=True, redact_url_credentials=True)。
// 记忆文件是用户/模型写的自由文本，难免混进 key；摘要是另一次模型调用，等于把 key 再发一遍。
interface RedactRule {
  re: RegExp;
  replace: (match: string, ...groups: any[]) => string;
}

const RULES: RedactRule[] = [
  {
    re: /\bsk-[A-Za-z0-9_-]{8,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bghp_[A-Za-z0-9]{20,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // GitHub 新式 token（issue #193）：fine-grained PAT / OAuth / 装置 / 刷新 / server-to-server
    re: /\b(?:github_pat|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{16,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // Google API key：AIza 后跟 35 位
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    // PEM 私钥块（issue #193）：BEGIN…END 整块吃掉，类型词（RSA/EC/OPENSSH…）任意
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
    replace: () => "[REDACTED]",
  },
  {
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: () => "[REDACTED]",
  },
  {
    re: /\b(api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=：]\s*\S+/gi,
    replace: (m) => {
      const kv = /^([^:=：]+[:=：]\s*)/.exec(m);
      return kv ? `${kv[1]}[REDACTED]` : "[REDACTED]";
    },
  },
  {
    re: /(密码|密钥|口令)\s*[:=：]\s*\S+/g,
    replace: (m) => {
      const kv = /^([^:=：]+[:=：]\s*)/.exec(m);
      return kv ? `${kv[1]}[REDACTED]` : "[REDACTED]";
    },
  },
  {
    re: /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    replace: (m, ...groups) => `${groups[0]}[REDACTED]@`,
  },
];

export function redactSensitiveText(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.replace);
  }
  return out;
}
export function clipHeadTail(text: string, head = 4000, tail = 1500, marker = "...[memory context truncated]..."): string {
  const cps = [...text];
  if (cps.length <= head + tail) return text;
  return cps.slice(0, head).join("") + marker + cps.slice(-tail).join("");
}
