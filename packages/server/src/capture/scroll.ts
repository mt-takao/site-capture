import type { Page } from 'playwright';

// 設計書 6.3「スクロール領域の検出」（J-03）と、J-04「末尾までスクロールして中身を描画させる」

// 見つけたスクロール領域に付ける目印。以降の処理はこの属性で要素を探す
export const SCROLL_ROOT_ATTR = 'data-sc-scroll-root';

export type ScrollTarget =
  | { kind: 'document'; scrollHeight: number; clientHeight: number }
  | {
      kind: 'element';
      selector: string; // 手動指定されたセレクタ、または自動検出の場合は目印の属性セレクタ
      autoDetected: boolean;
      scrollHeight: number;
      clientHeight: number;
      rect: { x: number; y: number; width: number; height: number };
    };

export async function findScrollTarget(page: Page, manualSelector?: string): Promise<ScrollTarget> {
  return page.evaluate(
    ({ manualSelector, attr }) => {
      const doc = document.scrollingElement ?? document.documentElement;
      const docResult = {
        kind: 'document' as const,
        scrollHeight: doc.scrollHeight,
        clientHeight: window.innerHeight,
      };
      const toResult = (el: Element, selector: string, autoDetected: boolean) => {
        const r = el.getBoundingClientRect();
        return {
          kind: 'element' as const,
          selector,
          autoDetected,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      };

      if (manualSelector) {
        const el = document.querySelector(manualSelector);
        if (el) return toResult(el, manualSelector, false);
      }

      const viewportArea = window.innerWidth * window.innerHeight;
      let best: Element | null = null;
      let bestHidden = 0;
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const style = getComputedStyle(el);
        if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
        const hidden = el.scrollHeight - el.clientHeight;
        if (hidden <= 0) continue;
        const r = el.getBoundingClientRect();
        const visibleW = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
        const visibleH = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
        if (visibleW * visibleH < viewportArea * 0.5) continue;
        if (hidden > bestHidden) {
          best = el;
          bestHidden = hidden;
        }
      }

      const docHidden = doc.scrollHeight - window.innerHeight;
      if (!best || docHidden >= bestHidden) return docResult;
      best.setAttribute(attr, '');
      return toResult(best, `[${attr}]`, true);
    },
    { manualSelector, attr: SCROLL_ROOT_ATTR },
  );
}

export type ScrollThroughOptions = {
  stepRatio: number; // 1回のスクロール量（表示の高さに対する割合）
  stepWaitMs: number; // 1回スクロールするごとの待ち時間
  maxDurationMs: number;
};

export const DEFAULT_SCROLL_THROUGH: ScrollThroughOptions = {
  stepRatio: 0.8,
  stepWaitMs: 150,
  maxDurationMs: 20000,
};

// 末尾までゆっくりスクロールし、先頭に戻す。スクロール中に中身が増えて高さが伸びても末尾まで追いかける。
export async function scrollThrough(
  page: Page,
  target: ScrollTarget,
  options: ScrollThroughOptions = DEFAULT_SCROLL_THROUGH,
): Promise<{ steps: number; finalScrollHeight: number; reachedEnd: boolean }> {
  const selector = target.kind === 'element' ? target.selector : null;
  const startedAt = Date.now();
  let steps = 0;
  let reachedEnd = false;
  let finalScrollHeight = target.scrollHeight;

  while (Date.now() - startedAt < options.maxDurationMs) {
    const pos = await page.evaluate(
      ({ selector, stepRatio }) => {
        const el = selector ? document.querySelector(selector) : document.scrollingElement;
        if (!el) return null;
        const clientHeight = selector ? el.clientHeight : window.innerHeight;
        el.scrollTop += Math.max(1, Math.floor(clientHeight * stepRatio));
        return { scrollTop: el.scrollTop, clientHeight, scrollHeight: el.scrollHeight };
      },
      { selector, stepRatio: options.stepRatio },
    );
    if (!pos) break;
    steps++;
    finalScrollHeight = pos.scrollHeight;
    await page.waitForTimeout(options.stepWaitMs);
    if (pos.scrollTop + pos.clientHeight >= pos.scrollHeight - 1) {
      // 末尾に着いた直後に中身が追加されることがあるので、高さが変わっていないか確かめる
      const after = await page.evaluate(
        (selector) => (selector ? document.querySelector(selector) : document.scrollingElement)?.scrollHeight ?? 0,
        selector,
      );
      if (after <= pos.scrollHeight) {
        reachedEnd = true;
        break;
      }
    }
  }

  await page.evaluate((selector) => {
    const el = selector ? document.querySelector(selector) : document.scrollingElement;
    if (el) el.scrollTop = 0;
  }, selector);

  return { steps, finalScrollHeight, reachedEnd };
}
