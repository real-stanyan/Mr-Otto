// 喂给摘要模型之前的脱敏。对标 hermes redact_sensitive_text(force=True, redact_url_credentials=True)。
// 记忆文件是用户/模型写的自由文本，难免混进 key；摘要是另一次模型调用，等于把 key 再发一遍。
const RULES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abp]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(api[_-]?key|access[_-]?token|secret|password|passwd|密码|密钥)\s*[:=：]\s*\S+/gi,
  /(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
];
export function redactSensitiveText(text: string): string {
  let out = text;
  for (const re of RULES) {
    out = out.replace(re, (m, ...groups) => {
      // URL 凭据：保留协议，只遮 user:pass
      if (m.startsWith("http")) return `${groups[0] as string}[REDACTED]@`;
      // key=value 类：保留键名，遮值
      const kv = /^([^:=：]+[:=：]\s*)/.exec(m);
      return kv ? `${kv[1]}[REDACTED]` : "[REDACTED]";
    });
  }
  return out;
}
export function clipHeadTail(text: string, head = 4000, tail = 1500, marker = "...[memory context truncated]..."): string {
  const cps = [...text];
  if (cps.length <= head + tail) return text;
  return cps.slice(0, head).join("") + marker + cps.slice(-tail).join("");
}
