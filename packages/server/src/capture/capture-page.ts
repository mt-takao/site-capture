import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright';
import { BlockedError, detectBlocked } from './blocked.js';
import { shotFileName } from './naming.js';
import {
  collectLinks,
  hideByText,
  HISTORY_HOOK_INIT_SCRIPT,
  injectCaptureStyles,
  runPageScript,
  TSX_COMPAT_INIT_SCRIPT,
} from './prepare.js';
import { findScrollTarget, scrollThrough } from './scroll.js';
import { shootDocument, shootExpanded, shootStitched, undoShootModifications, type ShotResult } from './shoot.js';
import { DOM_OBSERVER_INIT_SCRIPT, NetworkTracker, waitForStable } from './stabilize.js';
import { makeThumbnail } from './thumbnail.js';
import type { CaptureOptions, CapturePageResult, ShotRecord, SiteSettings, Viewport } from './types.js';

// 設計書 6.1「1ページを撮る手順」

export class NotHtmlError extends Error {
  constructor(readonly contentType: string) {
    super(`not html: ${contentType}`);
    this.name = 'NotHtmlError';
  }
}

export class PageTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`page timeout: ${timeoutMs}ms`);
    this.name = 'PageTimeoutError';
  }
}

// 撮影セッション単位のブラウザコンテキストを作る。ログイン状態や Basic 認証は options で渡す
export async function createCaptureContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ deviceScaleFactor: 1, locale: 'ja-JP', ...options });
  await context.addInitScript(TSX_COMPAT_INIT_SCRIPT);
  await context.addInitScript(DOM_OBSERVER_INIT_SCRIPT);
  await context.addInitScript(HISTORY_HOOK_INIT_SCRIPT);
  return context;
}

export type CapturePageInput = {
  context: BrowserContext;
  url: string;
  viewports: Viewport[];
  outDir: string; // 画像の保存先。サムネイルは outDir/.thumbs
  options: CaptureOptions;
  site: SiteSettings;
  log?: (message: string) => void;
};

type LoadedPage = { page: Page; network: NetworkTracker; status: number | null; waitTimedOut: boolean };

export async function capturePage(input: CapturePageInput): Promise<CapturePageResult> {
  const { context, url, site, options } = input;
  const log = input.log ?? (() => {});
  // リンクはいちばん広い画面幅で集めるので、広い順に撮る（設計書 5.1）
  const viewports = [...input.viewports].sort((a, b) => b.width - a.width);
  await mkdir(join(input.outDir, '.thumbs'), { recursive: true });

  const result: CapturePageResult = { url, finalUrl: url, httpStatus: null, title: '', links: [], shots: [] };
  let loaded: LoadedPage | null = null;
  try {
    for (const [i, vp] of viewports.entries()) {
      const shot = await withTimeout(options.pageTimeoutMs, async () => {
        if (site.reloadPerViewport || !loaded) {
          if (loaded) await loaded.page.close();
          loaded = await loadPage(context, url, vp, site, options, log);
        } else {
          // 1回の読み込みで画面幅を切り替えながら撮る（アクセス制限の厳しいサイト向け）
          await undoShootModifications(loaded.page);
          await loaded.page.setViewportSize(vp);
          const stable = await waitForStable(loaded.page, loaded.network, options);
          loaded.waitTimedOut = stable.timedOut;
        }
        if (i === 0) {
          result.httpStatus = loaded.status;
          result.finalUrl = loaded.page.url();
          result.title = await loaded.page.title();
          result.links = await collectLinks(loaded.page);
        }
        return shootViewport(loaded, url, vp, input.outDir, site, options, log);
      });
      result.shots.push(shot);
    }
  } finally {
    await (loaded as LoadedPage | null)?.page.close().catch(() => {});
  }
  return result;
}

// ①〜⑥: ページを開き、描画が落ち着いて撮影前スクリプトを実行し終えるまで
async function loadPage(
  context: BrowserContext,
  url: string,
  vp: Viewport,
  site: SiteSettings,
  options: CaptureOptions,
  log: (message: string) => void,
): Promise<LoadedPage> {
  const page = await context.newPage();
  await page.setViewportSize(vp);
  const network = new NetworkTracker(page);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.pageTimeoutMs }).catch((e) => {
    // PDF や ZIP などはブラウザがダウンロードとして扱い、ページとして開けない
    if (e instanceof Error && e.message.includes('Download is starting')) throw new NotHtmlError('download');
    throw e;
  });
  const status = response?.status() ?? null;
  const contentType = (await response?.headerValue('content-type')) ?? '';
  if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new NotHtmlError(contentType);

  await injectCaptureStyles(page, { hideSelectors: site.hideSelectors, disableAnimations: options.disableAnimations });
  if (site.waitForSelector) {
    await page.waitForSelector(site.waitForSelector, { timeout: options.maxWaitMs }).catch(() => {
      log(`待機対象の要素が表示されませんでした: ${site.waitForSelector}`);
    });
  }
  let stable = await waitForStable(page, network, options);
  const blocked = await detectBlocked(page, status, network);
  if (blocked) throw blocked;

  const scripts = [site.beforeCaptureScript, options.expandToggles ? site.expandTogglesScript : undefined].filter(
    (s): s is string => !!s,
  );
  for (const script of scripts) await runPageScript(page, script);
  if (scripts.length > 0) stable = await waitForStable(page, network, options);

  return { page, network, status, waitTimedOut: stable.timedOut };
}

// ⑦〜⑩: スクロール領域を見つけ、末尾まで描画させてから撮る
async function shootViewport(
  loaded: LoadedPage,
  url: string,
  vp: Viewport,
  outDir: string,
  site: SiteSettings,
  options: CaptureOptions,
  log: (message: string) => void,
): Promise<ShotRecord> {
  const { page, network } = loaded;
  await hideByText(page, site.hideByText);
  const target = await findScrollTarget(page, site.scrollContainerSelector);
  await scrollThrough(page, target);
  const settled = await waitForStable(page, network, { ...options, quietWindowMs: Math.min(500, options.quietWindowMs) });
  // スクロールで新しく描画された要素にも隠す処理をかける
  await hideByText(page, site.hideByText);
  await page.waitForTimeout(options.extraWaitMs);

  const limitedBefore = network.rateLimitedResponses().length;
  const blocked = await detectBlocked(page, loaded.status, network);
  if (blocked) throw blocked;

  const filePath = join(outDir, shotFileName(url, vp.width));
  let shot: ShotResult;
  let fellBack = false;
  if (target.kind === 'document') {
    shot = await shootDocument(page, filePath);
  } else {
    const expanded = await shootExpanded(page, target, filePath);
    if (expanded) {
      shot = expanded;
    } else {
      // 展開できなかったら書き換えを戻し、つなぎ合わせ方式で撮る
      log(`展開方式で撮れなかったため、つなぎ合わせ方式に切り替えます（${vp.width}px）`);
      fellBack = true;
      await undoShootModifications(page);
      const retarget = await findScrollTarget(page, site.scrollContainerSelector);
      shot =
        retarget.kind === 'element' ? await shootStitched(page, retarget, filePath) : await shootDocument(page, filePath);
    }
  }

  // 撮っている最中に制限された場合、欠けた画像を残さない（設計書 5.5）
  if (network.rateLimitedResponses().length > limitedBefore) {
    await rm(filePath, { force: true });
    const after = await detectBlocked(page, loaded.status, network);
    throw after ?? new BlockedError('partially-rate-limited', null);
  }

  const thumbPath = join(outDir, '.thumbs', shotFileName(url, vp.width).replace(/\.png$/, '.webp'));
  await makeThumbnail(filePath, thumbPath);
  return {
    viewportWidth: vp.width,
    filePath,
    thumbPath,
    imageWidth: shot.width,
    imageHeight: shot.height,
    method: shot.method,
    fellBackToStitch: fellBack,
    waitTimedOut: loaded.waitTimedOut || settled.timedOut,
  };
}

async function withTimeout<T>(ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PageTimeoutError(ms)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
