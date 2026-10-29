import type { Page } from 'playwright';

// アクセス制限やロボット確認の画面が出ていないかを調べる。
// 出ていた場合は撮影を失敗として記録し、確認を突破しようとはしない。

export type BlockedReason = 'rate-limited' | 'bot-challenge' | 'forbidden';

export async function detectBlocked(page: Page, status: number | null): Promise<BlockedReason | null> {
  const challenge = await page.evaluate(() => {
    const title = document.title.toLowerCase();
    return (
      title.includes('just a moment') ||
      title.includes('attention required') ||
      Array.from(document.querySelectorAll('iframe')).some((f) => f.src.includes('challenges.cloudflare.com')) ||
      document.querySelector('#challenge-form, #cf-challenge-running, .cf-turnstile') !== null
    );
  });
  if (challenge) return 'bot-challenge';
  if (status === 429) return 'rate-limited';
  if (status === 403) return 'forbidden';
  return null;
}
