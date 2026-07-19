/**
 * Retry transient RPC failures with jittered backoff.
 *
 * Ported from the app server. Public nodes answer `-32603 service temporarily
 * unavailable` under load (see FIXES.md — that blip is what made a working Starknet
 * config look misconfigured), and one blip must not fail a relay.
 */

interface RetryableLike {
  status?: unknown;
  statusCode?: unknown;
  response?: { status?: unknown; headers?: { get?: (name: string) => string | null } };
  headers?: { get?: (name: string) => string | null };
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  cause?: unknown;
}

const TRANSIENT_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
];

export function isRetryableRpcError(error: unknown): boolean {
  let current = error as RetryableLike | undefined;
  // Bounded walk: viem nests causes deeply and a cyclic chain would otherwise hang.
  for (let depth = 0; current && depth < 5; depth += 1) {
    const status = Number(current.status ?? current.statusCode ?? current.response?.status);
    if (status === 429 || status >= 500) return true;

    const code = Number(current.code);
    if (code === -32603 || code === -32005) return true;
    if (TRANSIENT_CODES.includes(String(current.code))) return true;

    const message = [current.message, current.shortMessage, current.details]
      .filter(Boolean)
      .join(" ");
    if (
      /\b429\b|rate[ -]?limit|too many requests|temporar(?:y|ily) unavailable|fetch failed|network error|timeout/i.test(
        message,
      )
    ) {
      return true;
    }
    current = current.cause as RetryableLike | undefined;
  }
  return false;
}

function retryAfterMs(error: unknown, now: () => number): number | null {
  const candidate = error as RetryableLike | undefined;
  const value =
    candidate?.response?.headers?.get?.("retry-after") ?? candidate?.headers?.get?.("retry-after");
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now());
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export async function retryRpc<T>(
  fn: () => Promise<T>,
  {
    attempts = 4,
    baseDelayMs = 500,
    now = () => Date.now(),
    random = Math.random,
    sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !isRetryableRpcError(error)) throw error;
      // Honour the server's own backpressure hint when it sends one; otherwise
      // exponential with jitter so retries from parallel destinations do not align.
      const retryAfter = retryAfterMs(error, now);
      const exponential = baseDelayMs * 2 ** attempt;
      const jittered = exponential * (0.75 + random() * 0.5);
      await sleep(retryAfter ?? jittered);
    }
  }
  throw lastError;
}
