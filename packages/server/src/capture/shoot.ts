import sharp, { type OverlayOptions } from 'sharp';
import type { Page } from 'playwright';
import type { ScrollTarget } from './scroll.js';

// 設計書 6.4「撮影方式」（S-01, J-03, J-05）

// これより高いページは分割して撮ってから結合する（J-05）
export const TILE_THRESHOLD_PX = 15000;
const TILE_HEIGHT_PX = 4000;

export type ShotResult = {
  method: 'fullpage' | 'tiled' | 'expand' | 'stitch';
  width: number;
  height: number;
  tiles: number;
};

// ページ全体（document）のスクロールで撮る。高さが閾値を超えたら分割して結合する
export async function shootDocument(page: Page, outPath: string): Promise<ShotResult> {
  const size = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    return { width: Math.ceil(doc.scrollWidth), height: Math.ceil(doc.scrollHeight) };
  });
  const width = page.viewportSize()?.width ?? size.width;

  // 横にはみ出す要素があっても画像の幅は画面幅にそろえる（展開方式で横幅が広がる場合があるため）
  if (size.height <= TILE_THRESHOLD_PX) {
    await page.screenshot({
      path: outPath,
      fullPage: true,
      clip: { x: 0, y: 0, width, height: size.height },
      animations: 'disabled',
    });
    return { method: 'fullpage', width, height: size.height, tiles: 1 };
  }

  const tiles: OverlayOptions[] = [];
  for (let y = 0; y < size.height; y += TILE_HEIGHT_PX) {
    const h = Math.min(TILE_HEIGHT_PX, size.height - y);
    const buf = await page.screenshot({ fullPage: true, clip: { x: 0, y, width, height: h }, animations: 'disabled' });
    tiles.push({ input: buf, top: y, left: 0 });
  }
  await sharp({ create: { width, height: size.height, channels: 4, background: '#ffffff' } })
    .composite(tiles)
    .png()
    .toFile(outPath);
  return { method: 'tiled', width, height: size.height, tiles: tiles.length };
}

// 展開方式: スクロール領域とその親の高さ制限を外し、ページ全体として撮る。
// 伸びきらなかった場合は null を返す（呼び出し側でつなぎ合わせ方式に切り替える）
export async function shootExpanded(
  page: Page,
  target: Extract<ScrollTarget, { kind: 'element' }>,
  outPath: string,
): Promise<(ShotResult & { expandedFrom: number }) | null> {
  const expanded = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const contentHeight = el.scrollHeight;
    for (let node: Element | null = el; node; node = node.parentElement) {
      node.setAttribute('data-sc-expand', '');
      const pos = getComputedStyle(node).position;
      if (pos === 'absolute' || pos === 'fixed') node.setAttribute('data-sc-expand-abs', '');
    }
    const style = document.createElement('style');
    style.textContent = `
      [data-sc-expand] { height: auto !important; max-height: none !important; min-height: 0 !important; overflow: visible !important; }
      [data-sc-expand-abs] { bottom: auto !important; }
    `;
    document.head.appendChild(style);
    // 仮想スクロールなど、表示の高さを見て描画する仕組みに、高さが変わったことを知らせる
    window.dispatchEvent(new Event('resize'));
    el.dispatchEvent(new Event('scroll'));
    return { contentHeight };
  }, target.selector);
  if (!expanded) return null;

  await page.waitForTimeout(300);
  const check = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    const doc = document.scrollingElement ?? document.documentElement;
    return {
      stillScrollable: el ? el.scrollHeight - el.clientHeight > 1 : true,
      docHeight: doc.scrollHeight,
    };
  }, target.selector);
  if (check.stillScrollable || check.docHeight < expanded.contentHeight * 0.95) return null;

  const shot = await shootDocument(page, outPath);
  return { ...shot, method: 'expand', expandedFrom: expanded.contentHeight };
}

// つなぎ合わせ方式: スクロール領域を表示の高さずつスクロールしながら撮り、結合する。
// 画面のうちスクロール領域の外（サイドバー、トップバーなど）は最初の1画面ぶんだけ写る
export async function shootStitched(
  page: Page,
  target: Extract<ScrollTarget, { kind: 'element' }>,
  outPath: string,
  stepWaitMs = 200,
): Promise<ShotResult> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');

  const info = await page.evaluate((selector) => {
    const el = document.querySelector(selector)!;
    el.scrollTop = 0;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(el.clientHeight),
      scrollHeight: el.scrollHeight,
    };
  }, target.selector);
  await page.waitForTimeout(stepWaitMs);

  const first = await page.screenshot({ animations: 'disabled' });
  const below = viewport.height - (info.y + info.height);
  const totalHeight = info.y + info.scrollHeight + Math.max(0, below);
  const layers: OverlayOptions[] = [{ input: first, top: 0, left: 0 }];

  // 2枚目以降はスクロール領域内の固定・追従要素（sticky/fixed）が何度も写らないように隠す
  let hidSticky = false;
  let finalScrollHeight = info.scrollHeight;
  for (let y = 0; ; y += info.height) {
    const actual = await page.evaluate(
      ({ selector, y }) => {
        const el = document.querySelector(selector)!;
        el.scrollTop = y;
        return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
      },
      { selector: target.selector, y },
    );
    finalScrollHeight = actual.scrollHeight;
    await page.waitForTimeout(stepWaitMs);
    const tile = await page.screenshot({
      clip: { x: info.x, y: info.y, width: info.width, height: info.height },
      animations: 'disabled',
    });
    layers.push({ input: tile, top: info.y + actual.scrollTop, left: info.x });
    if (actual.scrollTop + info.height >= actual.scrollHeight - 1) break;
    if (!hidSticky) {
      await page.evaluate((selector) => {
        const root = document.querySelector(selector)!;
        for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
          const pos = getComputedStyle(el).position;
          if (pos === 'sticky' || pos === 'fixed') el.style.setProperty('visibility', 'hidden', 'important');
        }
      }, target.selector);
      hidSticky = true;
    }
  }

  // スクロール中に中身が伸びた場合に合わせて、最終的な高さで画像を作る
  const height = info.y + finalScrollHeight + Math.max(0, below);
  if (below > 0) {
    const bottom = await sharp(first)
      .extract({ left: 0, top: viewport.height - below, width: viewport.width, height: below })
      .toBuffer();
    layers.push({ input: bottom, top: height - below, left: 0 });
  }
  await sharp({ create: { width: viewport.width, height: Math.max(height, totalHeight), channels: 4, background: '#ffffff' } })
    .composite(layers)
    .png()
    .toFile(outPath);
  return { method: 'stitch', width: viewport.width, height: Math.max(height, totalHeight), tiles: layers.length - 1 };
}
