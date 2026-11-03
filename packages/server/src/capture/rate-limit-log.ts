import type { RateLimitReport } from './capture-page.js';

// 429 の記録をターミナルに出す形にする（原因の調査用）。数えなかった通信も、その理由とともに全件出す
export function formatRateLimitReport(r: RateLimitReport, prefix = ''): string {
  const { document, sameSite, otherSite } = r.classify;
  const label = (x: (typeof r.responses)[number]) => {
    if (document.includes(x)) return 'ページ本体';
    if (sameSite.includes(x)) return x.recovered ? '同じサイト・回復' : '同じサイト・未回復';
    return otherSite.includes(x) ? 'ほかのサイト・数えない' : '';
  };
  const time = (at: number) => new Date(at).toTimeString().slice(0, 8);
  const lines = r.responses.map(
    (x) =>
      `  ${time(x.at)} [${label(x)}] ${x.method} ${x.resourceType} ${x.url}` + (x.retryAfterSec != null ? ` Retry-After=${x.retryAfterSec}s` : ''),
  );
  return [`${prefix}[429] ${r.pageUrl}（${r.viewportWidth}px）: ${r.responses.length}件`, ...lines].join('\n');
}
