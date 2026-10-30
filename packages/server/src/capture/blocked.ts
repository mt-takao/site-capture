import type { Page } from 'playwright';
import type { NetworkTracker } from './stabilize.js';

// 設計書 5.5: アクセス制限やロボット確認の画面が出ていないかを調べる。
// 出ていた場合は撮影を失敗として扱い、確認を突破しようとはしない。

export type BlockedReason = 'rate-limited' | 'partially-rate-limited' | 'bot-challenge' | 'forbidden';

export class BlockedError extends Error {
  constructor(
    readonly reason: BlockedReason,
    readonly retryAfterSec: number | null,
  ) {
    super(`blocked: ${reason}`);
    this.name = 'BlockedError';
  }
}

export async function detectBlocked(
  page: Page,
  status: number | null,
  network: NetworkTracker,
): Promise<BlockedError | null> {
  const challenge = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    return (
      title.includes('just a moment') ||
      title.includes('attention required') ||
      Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('challenges.cloudflare.com')) ||
      document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile') !== null
    );
  });
  const limited = network.rateLimitedResponses();
  const retryAfterSec = limited.reduce<number | null>(
    (max, r) => (r.retryAfterSec == null ? max : Math.max(max ?? 0, r.retryAfterSec)),
    null,
  );
  if (challenge) return new BlockedError('bot-challenge', retryAfterSec);
  if (status === 429) return new BlockedError('rate-limited', retryAfterSec);
  if (status === 403) return new BlockedError('forbidden', null);
  // ページ本体は返ったが、裏の通信が制限されて一部が描画されていない可能性がある
  if (limited.length > 0) return new BlockedError('partially-rate-limited', retryAfterSec);
  return null;
}
