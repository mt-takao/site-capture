import { BlockedError } from './blocked.js';

// 設計書 5.5「アクセス制限への対応」と C-11「アクセス間隔」。
// ホストごとに「次にアクセスしてよい時刻」を管理する。制限を受けたホストは待ち時間を入れ、以降の間隔を2倍にする。

export type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HostGate {
  private nextAllowedAt = new Map<string, number>();
  private multiplier = new Map<string, number>();

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: Sleep = realSleep,
  ) {}

  // アクセスしてよい時刻まで待ち、次の予約を入れる
  async acquire(host: string): Promise<void> {
    const wait = (this.nextAllowedAt.get(host) ?? 0) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextAllowedAt.set(host, this.now() + this.currentIntervalMs(host));
  }

  // 制限を受けたときに呼ぶ。waitMs の間はアクセスせず、以降の間隔を2倍にする
  penalize(host: string, waitMs: number): void {
    this.nextAllowedAt.set(host, Math.max(this.nextAllowedAt.get(host) ?? 0, this.now() + waitMs));
    this.multiplier.set(host, (this.multiplier.get(host) ?? 1) * 2);
  }

  currentIntervalMs(host: string): number {
    return this.intervalMs * (this.multiplier.get(host) ?? 1);
  }
}

// 制限を受けたら 60秒 → 120秒 → 240秒（Retry-After があればその秒数）待って撮り直す。3回撮り直してもだめなら諦める
export const RETRY_BACKOFF_SEC = [60, 120, 240];

export async function withRateLimitRetry<T>(
  gate: HostGate,
  host: string,
  fn: () => Promise<T>,
  onWait: (info: { error: BlockedError; waitSec: number; attempt: number }) => void = () => {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await gate.acquire(host);
    try {
      return await fn();
    } catch (e) {
      // 403（アクセス禁止）は待っても変わらないので撮り直さない
      if (!(e instanceof BlockedError) || e.reason === 'forbidden' || attempt >= RETRY_BACKOFF_SEC.length) throw e;
      const waitSec = e.retryAfterSec ?? RETRY_BACKOFF_SEC[attempt]!;
      gate.penalize(host, waitSec * 1000);
      onWait({ error: e, waitSec, attempt: attempt + 1 });
    }
  }
}
