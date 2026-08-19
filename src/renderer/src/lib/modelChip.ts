// "厂商/型号"这一行标签的拼法。
//
// 拎成函数是因为它踩过一次：model_changed 里的 model 对本机 Ollama 是带前缀的
// （"ollama/qwen3.8:27b"——日志得能自己说清是哪家的），再拼一次 provider 就成了
// "ollama/ollama/qwen3.8:27b"。厂商前缀已经在 id 里的时候，别再加一遍。
// OpenRouter 那种 id 本身带**别家**命名空间的（"anthropic/claude-sonnet-5"）
// 则该拼上去——"openrouter/anthropic/claude-sonnet-5" 说的是两件不同的事：
// 谁在转发，转发的是谁。

export function modelChipLabel(provider: string, model: string): string {
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}
