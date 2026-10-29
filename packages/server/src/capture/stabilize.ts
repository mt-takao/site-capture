import type { Page, Request } from 'playwright';

// 設計書 6.2「描画が落ち着いたかの判定」（J-01）

export type StabilizeOptions = {
  quietWindowMs: number;
  maxWaitMs: number;
};

export type StabilizeResult = {
  timedOut: boolean;
  elapsedMs: number;
  // 待ちきれなかったときに、どの条件が満たされていなかったか
  unmet: Array<'network' | 'dom' | 'fonts' | 'images'>;
};

// これより長くつながったままの通信は「長時間つながったままの通信」とみなして数えない
const LONG_LIVED_REQUEST_MS = 5000;
// 同じ通信（メソッド、クエリを除いたURL、送信内容が同じもの）がこの回数を超えたら、定期的な通信とみなして数えない。
// 送信内容まで見るのは、Notion のように1つのAPIのURLへ中身の違うPOSTを何度も送るサイトがあるため
const POLLING_THRESHOLD = 3;
// 同じ要素がこの回数を超えて変化したら、時計などの定期更新とみなして数えない
const REPEATED_MUTATION_THRESHOLD = 5;
const POLL_INTERVAL_MS = 100;

// ページ読み込み前に入れておくスクリプト。DOMの最後の変化時刻を記録する。
// 同じ要素が何度も変化する場合（時計、カルーセルなど）はその要素の変化を無視する。
export const DOM_OBSERVER_INIT_SCRIPT = `(() => {
  if (window.__scObserverInstalled) return;
  window.__scObserverInstalled = true;
  window.__scLastMutationAt = performance.now();
  const counts = new WeakMap();
  const start = () => {
    new MutationObserver((records) => {
      let significant = false;
      for (const r of records) {
        const target = r.type === 'characterData' ? r.target.parentNode : r.target;
        if (!target) continue;
        const n = (counts.get(target) || 0) + 1;
        counts.set(target, n);
        if (n <= ${REPEATED_MUTATION_THRESHOLD}) significant = true;
      }
      if (significant) window.__scLastMutationAt = performance.now();
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  start();
})();`;

// ページの通信を数える。ページを開く前に作り、そのページの撮影が終わるまで使い続ける。
export class NetworkTracker {
  private inflight = new Map<Request, number>();
  private urlCounts = new Map<string, number>();
  private lastActivityAt = Date.now();

  constructor(page: Page) {
    page.on('request', (req) => {
      const key = requestKey(req);
      this.urlCounts.set(key, (this.urlCounts.get(key) ?? 0) + 1);
      this.inflight.set(req, Date.now());
      if (!this.isIgnored(req)) this.lastActivityAt = Date.now();
    });
    const done = (req: Request) => {
      if (!this.isIgnored(req)) this.lastActivityAt = Date.now();
      this.inflight.delete(req);
    };
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  private isIgnored(req: Request): boolean {
    const type = req.resourceType();
    if (type === 'websocket' || type === 'eventsource') return true;
    return (this.urlCounts.get(requestKey(req)) ?? 0) > POLLING_THRESHOLD;
  }

  // 数える対象の通信がなく、最後の通信から quietMs 経っていれば true
  isQuiet(quietMs: number): boolean {
    const now = Date.now();
    for (const [req, startedAt] of this.inflight) {
      if (this.isIgnored(req)) continue;
      if (now - startedAt > LONG_LIVED_REQUEST_MS) continue;
      return false;
    }
    return now - this.lastActivityAt >= quietMs;
  }
}

function requestKey(req: Request): string {
  const url = req.url();
  const i = url.search(/[?#]/);
  return `${req.method()} ${i === -1 ? url : url.slice(0, i)} ${req.postData() ?? ''}`;
}

export async function waitForStable(
  page: Page,
  network: NetworkTracker,
  options: StabilizeOptions,
): Promise<StabilizeResult> {
  const startedAt = Date.now();
  let unmet: StabilizeResult['unmet'] = [];

  while (true) {
    const state = await page.evaluate(() => {
      const w = window as unknown as { __scLastMutationAt?: number };
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      // 遅延読み込みの画像は画面外では読み込まれないので、画面内の画像だけを見る
      const imagesLoaded = Array.from(document.images).every((img) => {
        const r = img.getBoundingClientRect();
        const visible = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw && r.width > 0;
        return !visible || img.complete;
      });
      return {
        msSinceMutation: performance.now() - (w.__scLastMutationAt ?? 0),
        fontsLoaded: document.fonts.status === 'loaded',
        imagesLoaded,
      };
    });

    unmet = [];
    if (!network.isQuiet(options.quietWindowMs)) unmet.push('network');
    if (state.msSinceMutation < options.quietWindowMs) unmet.push('dom');
    if (!state.fontsLoaded) unmet.push('fonts');
    if (!state.imagesLoaded) unmet.push('images');

    const elapsedMs = Date.now() - startedAt;
    if (unmet.length === 0) return { timedOut: false, elapsedMs, unmet };
    if (elapsedMs >= options.maxWaitMs) return { timedOut: true, elapsedMs, unmet };
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
}
