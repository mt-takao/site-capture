import type { Page } from 'playwright';
import { isSameSite } from '../crawler/scope.js';
import type { NetworkTracker, RateLimitedResponse } from './stabilize.js';

// 設計書 5.5: アクセス制限やロボット確認の画面が出ていないかを調べる。
// 出ていた場合は撮影を失敗として扱い、確認を突破しようとはしない。
//
// 429 の扱い:
// - ページ本体の 429 → 制限（rate-limited）
// - 同じサイト（登録ドメインが同じ）の通信の 429 → すぐには失敗にしない。ページ側の再送で回復するのを待ち、
//   回復しないまま残ったときだけ「一部が制限された」（partially-rate-limited）とする
// - ほかのサイトの通信の 429（解析用スクリプトなど）→ 数えない

export type BlockedReason = 'rate-limited' | 'partially-rate-limited' | 'bot-challenge' | 'forbidden';

export class BlockedError extends Error {
  constructor(
    readonly reason: BlockedReason,
    readonly retryAfterSec: number | null,
    // 判定の元になった 429 の通信（原因を調べるために、警告とエラーに要約を載せる）
    readonly responses: ReadonlyArray<RateLimitedResponse> = [],
  ) {
    super(`blocked: ${reason}`);
    this.name = 'BlockedError';
  }

  // 例: 「fetch /api/v3/syncRecordValues（未回復）ほか2件」
  get summary(): string {
    return summarizeRateLimited(this.responses);
  }
}

export function summarizeRateLimited(responses: ReadonlyArray<RateLimitedResponse>): string {
  if (responses.length === 0) return '';
  const describe = (r: RateLimitedResponse) => {
    const u = new URL(r.url);
    const kind = r.isDocument ? 'ページ本体' : r.resourceType;
    return `${kind} ${u.host}${u.pathname}${r.recovered ? '（回復）' : '（未回復）'}`;
  };
  const shown = responses.slice(0, 2).map(describe).join('、');
  return responses.length > 2 ? `429: ${shown} ほか${responses.length - 2}件` : `429: ${shown}`;
}

// 429 を返した通信を、判定での扱いごとに分ける
export function classifyRateLimited(pageUrl: string, responses: ReadonlyArray<RateLimitedResponse>) {
  const pageHost = new URL(pageUrl).hostname;
  const document = responses.filter((r) => r.isDocument);
  const sameSite = responses.filter((r) => !r.isDocument && isSameSite(new URL(r.url).hostname, pageHost, true));
  const otherSite = responses.filter((r) => !r.isDocument && !sameSite.includes(r));
  return { document, sameSite, unrecovered: sameSite.filter((r) => !r.recovered), otherSite };
}

// includePartial: false ならロボット確認とページ本体の制限だけを見る（読み込み直後。ページ側の再送を待つため）
export async function detectBlocked(
  page: Page,
  status: number | null,
  network: NetworkTracker,
  options: { includePartial: boolean },
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
  const all = network.rateLimitedResponses();
  const { document: documentHits, unrecovered } = classifyRateLimited(page.url(), all);
  const maxRetryAfter = (list: ReadonlyArray<RateLimitedResponse>) =>
    list.reduce<number | null>((max, r) => (r.retryAfterSec == null ? max : Math.max(max ?? 0, r.retryAfterSec)), null);

  if (challenge) return new BlockedError('bot-challenge', maxRetryAfter(all), all);
  if (status === 429) return new BlockedError('rate-limited', maxRetryAfter(documentHits) ?? maxRetryAfter(all), documentHits);
  if (status === 403) return new BlockedError('forbidden', null);
  // ページ本体は返ったが、同じサイトの通信が回復しないまま残っている。画面の一部が描画されていない可能性がある
  if (options.includePartial && unrecovered.length > 0) {
    return new BlockedError('partially-rate-limited', maxRetryAfter(unrecovered), unrecovered);
  }
  return null;
}

// 同じサイトの 429 が回復するのを、最大 timeoutMs 待つ。回復しないまま残った件数を返す
export async function waitForRecovery(page: Page, network: NetworkTracker, timeoutMs: number): Promise<number> {
  const startedAt = Date.now();
  while (true) {
    const left = classifyRateLimited(page.url(), network.rateLimitedResponses()).unrecovered.length;
    if (left === 0 || Date.now() - startedAt >= timeoutMs) return left;
    await page.waitForTimeout(200);
  }
}
