import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright';
import { BlockedError } from '../src/capture/blocked.js';
import { ClickNavigatedError, ClickTargetNotFoundError } from '../src/capture/click.js';
import { capturePage, createCaptureContext, NotHtmlError, type RateLimitReport } from '../src/capture/capture-page.js';
import { formatRateLimitReport } from '../src/capture/rate-limit-log.js';
import { collectLinks, hideByText, injectCaptureStyles, runPageScript } from '../src/capture/prepare.js';
import { DEFAULT_CAPTURE_OPTIONS, DEFAULT_SITE_SETTINGS, viewportForWidth, type SiteSettings } from '../src/capture/types.js';
import { findSiteSettings } from '../src/presets/index.js';
import { startFixtureServer } from './helpers/fixture-server.js';

// 実際に Chromium で検証用ページを撮る結合テスト

const options = { ...DEFAULT_CAPTURE_OPTIONS, extraWaitMs: 100 };
const viewports = [1440, 375].map(viewportForWidth);
const notionPreset = findSiteSettings('https://x.notion.site/');

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let workDir: string;

before(async () => {
  browser = await chromium.launch();
  server = await startFixtureServer();
  workDir = await mkdtemp(join(tmpdir(), 'site-capture-test-'));
});

after(async () => {
  await browser.close();
  await server.close();
  await rm(workDir, { recursive: true, force: true });
});

async function capture(path: string, site: SiteSettings, outName: string, reports: RateLimitReport[] = []) {
  const context = await createCaptureContext(browser);
  try {
    return await capturePage({
      context,
      url: `${server.origin}${path}`,
      viewports,
      outDir: join(workDir, outName),
      options,
      site,
      onRateLimited: (r) => reports.push(r),
    });
  } finally {
    await context.close();
  }
}

describe('撮影', () => {
  test('通常の長いページは分割撮影して結合し、サムネイルも作る', async () => {
    const r = await capture('/long-static.html', DEFAULT_SITE_SETTINGS, 'long');
    assert.equal(r.httpStatus, 200);
    assert.equal(r.title, '通常の長いページ');
    assert.deepEqual(r.shots.map((s) => s.viewportWidth), [1440, 375]);
    for (const s of r.shots) {
      assert.equal(s.method, 'tiled');
      assert.ok(s.imageHeight > 25000);
      const meta = await sharp(s.filePath).metadata();
      assert.equal(meta.width, s.viewportWidth);
      assert.equal(meta.height, s.imageHeight);
      assert.ok((await stat(s.thumbPath)).size > 0);
    }
    assert.match(r.shots[0]!.filePath, /long-static__1440\.png$/);
  });

  test('1回の読み込みで撮っても、画面幅ごとに開き直した場合と同じ高さになる', async () => {
    const reload = await capture('/spa-inner-scroll.html', DEFAULT_SITE_SETTINGS, 'inner-reload');
    const single = await capture('/spa-inner-scroll.html', { ...DEFAULT_SITE_SETTINGS, reloadPerViewport: false }, 'inner-single');
    for (const r of [reload, single]) {
      assert.deepEqual(r.shots.map((s) => s.method), ['expand', 'expand']);
      assert.ok(r.shots.every((s) => !s.fellBackToStitch));
    }
    assert.deepEqual(
      single.shots.map((s) => s.imageHeight),
      reload.shots.map((s) => s.imageHeight),
    );
  });

  test('仮想スクロールのページも、1回の読み込みで2つの画面幅とも末尾まで撮れる', async () => {
    const r = await capture('/spa-virtual.html', { ...DEFAULT_SITE_SETTINGS, reloadPerViewport: false }, 'virtual');
    for (const s of r.shots) assert.ok(s.imageHeight >= 500 * 48, `${s.viewportWidth}px: ${s.imageHeight}`);
  });

  test('Notion 用プリセットで、ボタンを隠しトグルを開いてから撮る', async () => {
    const context = await createCaptureContext(browser);
    const r = await capturePage({
      context,
      url: `${server.origin}/notion-like.html`,
      viewports,
      outDir: join(workDir, 'notion-like'),
      options: { ...options, expandToggles: true },
      site: notionPreset,
    });
    await context.close();
    assert.deepEqual(r.shots.map((s) => s.viewportWidth), [1440, 375]);
    assert.ok(r.links.some((u) => u.endsWith('/about')));
  });
});

describe('要素を押してから撮る（J-10）', () => {
  const clickSite: SiteSettings = { ...DEFAULT_SITE_SETTINGS, clickSelectors: ['[data-case]', '[data-nav]'] };

  test('ふつうのページの撮影で、押す要素を見えているものだけ集める', async () => {
    const r = await capture('/dialog.html', clickSite, 'dialog-normal');
    assert.deepEqual(
      r.clickTargets.map((t) => [t.no, t.selector, t.index, t.label]),
      [
        [1, '[data-case]', 0, '事例A'],
        [2, '[data-case]', 1, '事例B'],
        [3, '[data-nav]', 0, '別のページへ'],
      ],
    );
  });

  test('押して開いたダイアログを、中のスクロールの最後まで撮る', async () => {
    const r = await capturePageWithClick('/dialog.html', { selector: '[data-case]', index: 1, no: 2, label: '事例B' }, 'dialog-b');
    assert.equal(r.title, '事例B：小売業の在庫管理');
    assert.deepEqual(r.links, []);
    assert.deepEqual(r.clickTargets, []);
    for (const s of r.shots) {
      assert.match(s.filePath, /dialog__click-2__\d+\.png$/);
      // 固定のダイアログをページの中に置き直して伸ばし、1回で撮る（つなぎ目ができないように）
      assert.equal(s.method, 'expand');
      assert.equal(s.fellBackToStitch, false);
      // ダイアログの中身（セクション 6 つ × 400px）が写るまで画像が伸びている
      assert.ok(s.imageHeight > 2400, `${s.viewportWidth}px: ${s.imageHeight}`);
    }
  });

  test('1回の読み込みで画面幅を切り替える設定でも、ダイアログを開いたまま撮る', async () => {
    const r = await capturePageWithClick(
      '/dialog.html',
      { selector: '[data-case]', index: 0, no: 1, label: '事例A' },
      'dialog-single',
      { reloadPerViewport: false },
    );
    assert.equal(r.title, '事例A：製造業の知識共有');
    assert.ok(r.shots.every((s) => s.imageHeight > 2400));
  });

  test('押すと別のページに移動する要素や、見つからない要素は撮らない', async () => {
    await assert.rejects(
      capturePageWithClick('/dialog.html', { selector: '[data-nav]', index: 0, no: 3, label: '別のページへ' }, 'dialog-nav'),
      ClickNavigatedError,
    );
    await assert.rejects(
      capturePageWithClick('/dialog.html', { selector: '[data-case]', index: 5, no: 9, label: '事例X' }, 'dialog-missing'),
      ClickTargetNotFoundError,
    );
  });
});

async function capturePageWithClick(
  path: string,
  click: { selector: string; index: number; no: number; label: string },
  outName: string,
  site: Partial<SiteSettings> = {},
) {
  const context = await createCaptureContext(browser);
  try {
    return await capturePage({
      context,
      url: `${server.origin}${path}`,
      viewports,
      outDir: join(workDir, outName),
      options,
      site: { ...DEFAULT_SITE_SETTINGS, ...site },
      click,
    });
  } finally {
    await context.close();
  }
}

describe('ページへの処理', () => {
  test('トグルを開くスクリプトは、入れ子のトグルも開き、ポップアップのボタンは押さない', async () => {
    const context = await createCaptureContext(browser);
    const page = await context.newPage();
    await page.goto(`${server.origin}/notion-like.html`);
    await runPageScript(page, notionPreset.expandTogglesScript!);
    const state = await page.evaluate(() => ({
      toggles: Array.from(document.querySelectorAll('.t')).map((t) => t.getAttribute('aria-expanded')),
      popupOpened: document.body.dataset.popupOpened ?? 'false',
    }));
    assert.deepEqual(state.toggles, ['true', 'true']);
    assert.equal(state.popupOpened, 'false');
    await context.close();
  });

  test('隠す要素とアニメーション停止の CSS を差し込み、実際に効いたかを返す', async () => {
    const context = await createCaptureContext(browser);
    const page = await context.newPage();
    await page.goto(`${server.origin}/notion-like.html`);
    assert.equal(await injectCaptureStyles(page, { hideSelectors: ['.topbar'], disableAnimations: true }), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')!).visibility), 'hidden');

    // CSP でインラインのスタイルが禁止されたページでは、差し込めなかったことを返す
    await page.goto(`${server.origin}/csp-strict.html`);
    assert.equal(await injectCaptureStyles(page, { hideSelectors: ['h1'], disableAnimations: true }), false);
    await context.close();
  });

  test('文字列で探して、それを含むボタンごと隠す', async () => {
    const context = await createCaptureContext(browser);
    const page = await context.newPage();
    await page.goto(`${server.origin}/notion-like.html`);
    assert.equal(await hideByText(page, ['Get Notion free']), 1);
    const visibility = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll<HTMLElement>('[role="button"]')).find((b) =>
        b.textContent?.includes('Get Notion free'),
      )!;
      return getComputedStyle(btn).visibility;
    });
    assert.equal(visibility, 'hidden');
    await context.close();
  });

  test('リンクと、History API で移動したURLを集める（http 以外は除く）', async () => {
    const context = await createCaptureContext(browser);
    const page = await context.newPage();
    await page.goto(`${server.origin}/notion-like.html`);
    const links = await collectLinks(page);
    assert.ok(links.includes(`${server.origin}/about`));
    assert.ok(links.includes(`${server.origin}/blog/hello?utm_source=x`));
    assert.ok(links.includes(`${server.origin}/spa/route`));
    assert.ok(!links.some((u) => u.startsWith('mailto:')));
    await context.close();
  });
});

describe('失敗の扱い', () => {
  test('同じサイトの通信が 429 のまま回復しなければ、一部が制限されたとして失敗にし、画像を残さない', async () => {
    const reports: RateLimitReport[] = [];
    await assert.rejects(capture('/partially-limited.html', DEFAULT_SITE_SETTINGS, 'partial', reports), (e: unknown) => {
      assert.ok(e instanceof BlockedError);
      assert.equal(e.reason, 'partially-rate-limited');
      assert.equal(e.retryAfterSec, 1);
      // 原因を調べられるよう、どの通信かを要約に載せる
      assert.match(e.summary, /^429: fetch 127\.0\.0\.1:\d+\/api\/limited（未回復）$/);
      return true;
    });
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.classify.unrecovered.length, 1);
    const files = await readdir(join(workDir, 'partial')).catch(() => []);
    assert.ok(!files.some((f) => f.endsWith('.png')));
  });

  test('ページ本体が 429 なら制限として失敗にする', async () => {
    const reports: RateLimitReport[] = [];
    await assert.rejects(capture('/limited-page', DEFAULT_SITE_SETTINGS, 'limited', reports), (e: unknown) => {
      assert.ok(e instanceof BlockedError);
      assert.equal(e.reason, 'rate-limited');
      assert.equal(e.retryAfterSec, 2);
      assert.match(e.summary, /ページ本体/);
      return true;
    });
    // 読み込みの途中で失敗しても、記録は渡す
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.classify.document.length, 1);
  });

  test('同じサイトの通信の 429 が、ページ側の再送で回復すれば撮影を続ける', async () => {
    const reports: RateLimitReport[] = [];
    const r = await capture('/recovering.html', DEFAULT_SITE_SETTINGS, 'recovering', reports);
    assert.equal(r.shots.length, 2);
    // 1つ目の画面幅で 429 → 回復。2つ目は読み込み直しても 429 は出ない
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.responses[0]!.recovered, true);
    assert.equal(reports[0]!.responses[0]!.resourceType, 'fetch');
    assert.equal(reports[0]!.classify.unrecovered.length, 0);
  });

  test('ほかのサイトの通信の 429 は数えずに撮る（記録には残す）', async () => {
    const reports: RateLimitReport[] = [];
    const r = await capture('/cross-site-429.html', DEFAULT_SITE_SETTINGS, 'cross-site', reports);
    assert.equal(r.shots.length, 2);
    assert.ok(reports.length >= 1);
    assert.equal(reports[0]!.classify.otherSite.length, 1);
    assert.equal(reports[0]!.classify.unrecovered.length, 0);
    // ターミナルに出す記録では、数えなかった理由も分かるようにする
    const text = formatRateLimitReport(reports[0]!, '#1 ');
    assert.match(text, /^#1 \[429\] .*cross-site-429\.html（1440px）: 1件/);
    assert.match(text, /\[ほかのサイト・数えない\] GET image http:\/\/localhost:\d+\/api\/limited/);
  });

  test('撮影用の CSS を差し込めなくても、警告を出して撮影は続ける', async () => {
    const context = await createCaptureContext(browser);
    const logs: string[] = [];
    const r = await capturePage({
      context,
      url: `${server.origin}/csp-strict.html`,
      viewports,
      outDir: join(workDir, 'csp-strict'),
      options,
      site: DEFAULT_SITE_SETTINGS,
      log: (m) => logs.push(m),
    });
    await context.close();
    assert.equal(r.shots.length, 2);
    assert.ok(logs.some((m) => m.includes('CSS を差し込めませんでした')));
  });

  test('HTML 以外は撮らない', async () => {
    await assert.rejects(capture('/file.pdf', DEFAULT_SITE_SETTINGS, 'pdf'), NotHtmlError);
  });
});
