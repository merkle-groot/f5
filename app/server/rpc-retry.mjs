export function isRetryableRpcError(error) {
  let current = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const status = Number(current.status ?? current.statusCode ?? current.response?.status);
    if (status === 429 || status >= 500) return true;
    const code = Number(current.code);
    if (code === -32603 || code === -32005) return true;
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(String(current.code))) {
      return true;
    }
    const message = [current.message, current.shortMessage, current.details].filter(Boolean).join(" ");
    if (/\b429\b|rate[ -]?limit|too many requests|temporar(?:y|ily) unavailable|fetch failed|network error|timeout/i.test(message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
}
function retryAfterMs(error, now) {
  const value = error?.response?.headers?.get?.("retry-after") ?? error?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

export async function retryRpc(
  fn,
  {
    attempts = 4,
    baseDelayMs = 500,
    now = () => Date.now(),
    random = Math.random,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableRpcError(error)) throw error;
      const retryAfter = retryAfterMs(error, now);
      const exponential = baseDelayMs * 2 ** attempt;
      const jittered = exponential * (0.75 + random() * 0.5);
      await sleep(retryAfter ?? jittered);
    }
  }
  throw lastError;
}
