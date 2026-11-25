import sharp, { type OverlayOptions } from 'sharp';
import type { Page } from 'playwright';
import type { ScrollTarget } from './scroll.js';
import { DEBUG, describeScrollLinkedForDebug } from './embed-debug.js';

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
// maxHeight を渡すと、ページの先頭からその高さまでを撮る
export async function shootDocument(page: Page, outPath: string, maxHeight?: number): Promise<ShotResult> {
  const size = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    return { width: Math.ceil(doc.scrollWidth), height: Math.ceil(doc.scrollHeight) };
  });
  if (maxHeight != null) size.height = Math.min(size.height, maxHeight);
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
    style.setAttribute('data-sc-expand-style', '');
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
  // 画像の余白を、1枚目の画面の左下の色で塗る（固定のダイアログを撮るとき、ダイアログの横の背景を続けて見せるため）
  fillFromFirstShot = false,
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
          if (pos !== 'sticky' && pos !== 'fixed') continue;
          el.setAttribute('data-sc-stitch-hidden', el.style.getPropertyValue('visibility'));
          el.style.setProperty('visibility', 'hidden', 'important');
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
  let background: { r: number; g: number; b: number; alpha: number } | string = '#ffffff';
  if (fillFromFirstShot) {
    const px = await sharp(first).extract({ left: 0, top: viewport.height - 1, width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    background = { r: px[0]!, g: px[1]!, b: px[2]!, alpha: 1 };
  }
  await sharp({ create: { width: viewport.width, height: Math.max(height, totalHeight), channels: 4, background } })
    .composite(layers)
    .png()
    .toFile(outPath);
  return { method: 'stitch', width: viewport.width, height: Math.max(height, totalHeight), tiles: layers.length - 1 };
}

// ページ全体のつなぎ合わせ方式（サイト設定 scrollStitch）: ページ全体を画面の高さずつスクロールしながら、
// 見えている画面を撮ってつなげる。スクロールに合わせて表示が変わるページ（スクロールの間だけ画面に留まる場面、
// 画面に入ったときだけ現れる要素）は、ページ全体を1枚で撮ると先頭の状態のまま写るため、この方式で撮る
const MAX_SCROLL_TILES = 60;
// これより低い固定・追従要素（ヘッダーなど）は、2枚目以降で隠して何度も写らないようにする。
// 画面の大部分を占める固定・追従要素は、スクロールに合わせて切り替わる場面そのものなので隠さない
const SMALL_FIXED_RATIO = 0.3;

// スクロールした後、画面が動かなくなるまで（続けて撮った2枚が同じになるまで）待ってから撮る。
// なめらかにスクロールする仕組みは、中身をスクロール位置へ少しずつ追いつかせるので、決まった時間だけ待つと途中の位置で写る。
// 動き続ける要素（動画など）があって止まらないときは、最大時間まで待って最後の1枚を使う
const STILL_CHECK_MS = 150;
const STILL_MAX_MS = 3000;

async function shootWhenStill(page: Page): Promise<Buffer> {
  let prev = await page.screenshot({ animations: 'disabled' });
  for (let waited = 0; waited < STILL_MAX_MS; waited += STILL_CHECK_MS) {
    await page.waitForTimeout(STILL_CHECK_MS);
    const next = await page.screenshot({ animations: 'disabled' });
    if (next.equals(prev)) return next;
    prev = next;
  }
  return prev;
}

// 画面に留まる場面（画面の高さの 80% 以上ある sticky の要素）が、いま画面に留まっていて、次の1画面の途中で離れる場合、
// 離れる位置（スクロール位置）を返す。留まっている間の画面と、離れた後の画面をそのままつなぐと、場面の中身が2回写るため
const PINNED_SCENE_RATIO = 0.8;

async function findStickyRelease(page: Page, viewportHeight: number): Promise<number | null> {
  return page.evaluate(
    ({ vh, ratio }) => {
      const sy = window.scrollY;
      let best: number | null = null;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
        const cs = getComputedStyle(el);
        if (cs.position !== 'sticky') continue;
        const r = el.getBoundingClientRect();
        if (r.height < vh * ratio) continue;
        const top = parseFloat(cs.top);
        // top が指定されていない、またはいま画面に留まっていない
        if (Number.isNaN(top) || Math.abs(r.top - top) > 1) continue;
        const parent = el.parentElement;
        if (!parent) continue;
        const pr = parent.getBoundingClientRect();
        const padBottom = parseFloat(getComputedStyle(parent).paddingBottom) || 0;
        // 親の下端（内側）が要素の下端に届いたところで、要素は画面から離れて一緒に動き出す
        const release = Math.round(sy + pr.bottom - padBottom - r.height - top);
        if (release > sy + 1 && release < sy + vh - 1) best = best == null ? release : Math.min(best, release);
      }
      return best;
    },
    { vh: viewportHeight, ratio: PINNED_SCENE_RATIO },
  );
}

export async function shootDocumentStitched(page: Page, outPath: string, stepWaitMs = 300): Promise<ShotResult> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('viewport is not set');
  const scrollTo = (y: number) =>
    page.evaluate((y) => {
      window.scrollTo(0, y);
      window.dispatchEvent(new Event('scroll'));
      const doc = document.scrollingElement ?? document.documentElement;
      return { scrollY: Math.round(window.scrollY), scrollHeight: Math.ceil(doc.scrollHeight) };
    }, y);

  const layers: OverlayOptions[] = [];
  let pos = await scrollTo(0);
  await page.waitForTimeout(stepWaitMs);
  let hidFixed = false;
  let bottom = 0;
  // 画面に留まる場面の、飛ばしたスクロールの量。画像の中の位置は、スクロール位置からこの分だけ上にずらす
  let skipped = 0;
  for (let i = 0; i < MAX_SCROLL_TILES; i++) {
    // 画面に留まる場面が、この画面の途中で離れるなら、離れる位置までスクロールしてから撮る。
    // 留まっている間はスクロールしても場面がほとんど変わらないので、その分を飛ばして前の画面のすぐ下につなぐ。
    // 最初の画面では飛ばさない（ページの先頭の中身を失わないため）
    if (i > 0) {
      const release = await findStickyRelease(page, viewport.height);
      if (release != null) {
        const before = pos.scrollY;
        pos = await scrollTo(release);
        await page.waitForTimeout(stepWaitMs);
        skipped += Math.max(0, pos.scrollY - before);
      }
    }
    const tile = await shootWhenStill(page);
    // スクロールに合わせて動く仕組みが、待つ間にスクロール位置を変えることがあるので、撮った後の位置で重ねる
    pos = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      return { scrollY: Math.round(window.scrollY), scrollHeight: Math.ceil(doc.scrollHeight) };
    });
    const top = pos.scrollY - skipped;
    layers.push({ input: tile, top, left: 0 });
    if (DEBUG) {
      if (skipped > 0) console.log(`[スクロールの調査] 画面に留まる場面の ${skipped}px を飛ばしています`);
      for (const line of await describeScrollLinkedForDebug(page, i)) console.log(line);
    }
    bottom = Math.max(bottom, top + viewport.height);
    if (pos.scrollY + viewport.height >= pos.scrollHeight - 1) break;
    if (!hidFixed) {
      await page.evaluate(
        (maxHeight) => {
          for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
            const position = getComputedStyle(el).position;
            if (position !== 'fixed' && position !== 'sticky') continue;
            if (el.getBoundingClientRect().height > maxHeight) continue;
            el.setAttribute('data-sc-stitch-hidden', el.style.getPropertyValue('visibility'));
            el.style.setProperty('visibility', 'hidden', 'important');
          }
        },
        viewport.height * SMALL_FIXED_RATIO,
      );
      hidFixed = true;
    }
    const next = await scrollTo(pos.scrollY + viewport.height);
    // スクロールできなくなったら終わり（ページの高さが変わらないのにスクロール位置が進まない）
    if (next.scrollY <= pos.scrollY) break;
    pos = next;
    await page.waitForTimeout(stepWaitMs);
  }

  const height = Math.max(bottom, viewport.height);
  await sharp({ create: { width: viewport.width, height, channels: 4, background: '#ffffff' } })
    .composite(layers)
    .png()
    .toFile(outPath);
  await undoShootModifications(page);
  return { method: 'stitch', width: viewport.width, height, tiles: layers.length };
}

// 展開方式・つなぎ合わせ方式・スクロール領域の検出でページに加えた書き換えを元に戻す。
// 1回の読み込みで画面幅を切り替えながら撮るときに、次の幅を撮る前に呼ぶ（設計書 6.1）
export async function undoShootModifications(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('style[data-sc-expand-style]').forEach((el) => el.remove());
    for (const attr of ['data-sc-expand', 'data-sc-expand-abs', 'data-sc-scroll-root']) {
      document.querySelectorAll(`[${attr}]`).forEach((el) => el.removeAttribute(attr));
    }
    document.querySelectorAll<HTMLElement>('[data-sc-stitch-hidden]').forEach((el) => {
      const before = el.getAttribute('data-sc-stitch-hidden');
      if (before) el.style.setProperty('visibility', before);
      else el.style.removeProperty('visibility');
      el.removeAttribute('data-sc-stitch-hidden');
    });
    const doc = document.scrollingElement ?? document.documentElement;
    doc.scrollTop = 0;
  });
}

// 別のサイトを埋め込んだ iframe は、ページ全体を1枚で撮ると、画面の外にある部分が白く写る（Chromium が別のプロセスで描くため）。
// iframe ごとに画面の中へスクロールして撮り直し、ページ全体の画像の同じ位置に重ねる。
// 画像の座標がページの座標と同じ撮り方（ページ全体・分割・展開）のときだけ使う。重ねた数を返す
const IFRAME_ATTR = 'data-sc-iframe';
const MIN_IFRAME_PX = 50;

export async function overlayIframes(page: Page, outPath: string): Promise<number> {
  const frames = await page.evaluate(
    ({ attr, min }) => {
      const out: Array<{ id: number; x: number; y: number; width: number; height: number }> = [];
      // Shadow DOM の中もたどる
      const roots: Array<Document | ShadowRoot> = [document];
      for (let i = 0; i < roots.length; i++) {
        for (const el of Array.from(roots[i]!.querySelectorAll('*'))) {
          if (el.shadowRoot) roots.push(el.shadowRoot);
          if (el.tagName !== 'IFRAME') continue;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          if (r.width < min || r.height < min || cs.visibility === 'hidden' || cs.display === 'none') continue;
          el.setAttribute(attr, String(out.length));
          out.push({ id: out.length, x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height });
        }
      }
      return out;
    },
    { attr: IFRAME_ATTR, min: MIN_IFRAME_PX },
  );
  if (frames.length === 0) return 0;

  const viewport = page.viewportSize();
  const meta = await sharp(outPath).metadata();
  const layers: OverlayOptions[] = [];
  for (const f of frames) {
    // 画面より高い iframe は、画面の中に収まらず同じ理由で白くなるので重ねない
    if (viewport && f.height > viewport.height) continue;
    const left = Math.round(f.x);
    const top = Math.round(f.y);
    if (left >= (meta.width ?? 0) || top >= (meta.height ?? 0)) continue;
    try {
      const locator = page.locator(`[${IFRAME_ATTR}="${f.id}"]`);
      // 画面の真ん中に来るようにスクロールしてから撮る（上端だと固定のヘッダーが重なることがあるため）
      await locator.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
      await page.waitForTimeout(300);
      let buf = await locator.screenshot({ animations: 'disabled', timeout: 5000 });
      // 画像からはみ出す分は切り落とす
      const bm = await sharp(buf).metadata();
      const w = Math.min(bm.width ?? 0, (meta.width ?? 0) - left);
      const h = Math.min(bm.height ?? 0, (meta.height ?? 0) - top);
      if (w <= 0 || h <= 0) continue;
      if (w !== bm.width || h !== bm.height) buf = await sharp(buf).extract({ left: 0, top: 0, width: w, height: h }).toBuffer();
      layers.push({ input: buf, left, top });
    } catch {
      // 撮れなかった iframe はそのまま（白いまま）にする
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  if (layers.length === 0) return 0;
  const merged = await sharp(outPath).composite(layers).png().toBuffer();
  await sharp(merged).toFile(outPath);
  return layers.length;
}
