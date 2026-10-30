import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { chromium, type Browser } from 'playwright';
import { BlockedError } from '../src/capture/blocked.js';
import { capturePage, createCaptureContext, NotHtmlError } from '../src/capture/capture-page.js';
import { collectLinks, hideByText, runPageScript } from '../src/capture/prepare.js';
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

async function capture(path: string, site: SiteSettings, outName: string) {
  const context = await createCaptureContext(browser);
  try {
    return await capturePage({
      context,
      url: `${server.origin}${path}`,
      viewports,
      outDir: join(workDir, outName),
      options,
      site,
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
  test('裏の通信が 429 を返したら、一部が制限されたとして失敗にし、画像を残さない', async () => {
    await assert.rejects(capture('/partially-limited.html', DEFAULT_SITE_SETTINGS, 'partial'), (e: unknown) => {
      assert.ok(e instanceof BlockedError);
      assert.equal(e.reason, 'partially-rate-limited');
      assert.equal(e.retryAfterSec, 1);
      return true;
    });
    const files = await readdir(join(workDir, 'partial')).catch(() => []);
    assert.ok(!files.some((f) => f.endsWith('.png')));
  });

  test('ページ本体が 429 なら制限として失敗にする', async () => {
    await assert.rejects(capture('/limited-page', DEFAULT_SITE_SETTINGS, 'limited'), (e: unknown) => {
      assert.ok(e instanceof BlockedError);
      assert.equal(e.reason, 'rate-limited');
      assert.equal(e.retryAfterSec, 2);
      return true;
    });
  });

  test('HTML 以外は撮らない', async () => {
    await assert.rejects(capture('/file.pdf', DEFAULT_SITE_SETTINGS, 'pdf'), NotHtmlError);
  });
});
