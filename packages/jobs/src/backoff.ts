export type BackoffOptions = {
  baseMs?: number;
  maxMs?: number;
  jitter?: number;
  random?: () => number;
};

export function retryDelay(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const baseMs = options.baseMs ?? 1_000;
  const maxMs = options.maxMs ?? 300_000;
  const jitter = options.jitter ?? 0.2;
  const random = options.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const spread = exponential * jitter;
  return Math.max(0, Math.round(exponential - spread + random() * spread * 2));
}
