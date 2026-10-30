import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { defaultCrawlSettings, type CrawlEvent, type CrawlSettings } from '../src/crawler/types.js';
import { Store } from '../src/db/store.js';
import { CrawlRunner } from '../src/jobs/crawl-runner.js';
import { BLOG_POSTS, startSiteServer } from './helpers/site-server.js';

// テスト用サイトを実際に巡回する結合テスト。速く終わるよう画面幅は1つ、待ち時間は短くする

let browser: Browser;
let site: Awaited<ReturnType<typeof startSiteServer>>;
let dir: string;
let store: Store;

before(async () => {
  browser = await chromium.launch();
  site = await startSiteServer();
  dir = await mkdtemp(join(tmpdir(), 'site-capture-crawl-'));
  store = new Store(join(dir, 'test.db'));
});

after(async () => {
  store.close();
  await browser.close();
  await site.close();
  await rm(dir, { recursive: true, force: true });
});

function settings(overrides: Partial<CrawlSettings> = {}): CrawlSettings {
  const d = defaultCrawlSettings(`${site.origin}/`);
  return {
    ...d,
    viewports: [800],
    intervalMs: 0,
    capture: { ...d.capture, quietWindowMs: 200, maxWaitMs: 3000, extraWaitMs: 0 },
    ...overrides,
  };
}

async function crawl(name: string, overrides: Partial<CrawlSettings> = {}, onEvent?: (e: CrawlEvent, r: CrawlRunner) => void) {
  const runner = new CrawlRunner({ store, browser, settings: settings(overrides), outputDir: join(dir, name) });
  const events: CrawlEvent[] = [];
  runner.subscribe((e) => {
    events.push(e);
    onEvent?.(e, runner);
  });
  const status = await runner.run();
  const pages = store.listPages(runner.crawlId);
  const paths = (s: string) => pages.filter((p) => p.status === s).map((p) => new URL(p.normalized_url).pathname + new URL(p.normalized_url).search).sort();
  return { runner, status, events, pages, paths, crawl: store.getCrawl(runner.crawlId)! };
}

const allPosts = Array.from({ length: BLOG_POSTS }, (_, i) => `/blog/post-${i + 1}`);

test('サイト全体を巡回し、範囲内のページをすべて1回ずつ撮る', async () => {
  const r = await crawl('full');
  assert.equal(r.status, 'done');
  assert.deepEqual(r.paths('done'), [
    '/', '/about', '/blog', ...allPosts, '/broken', '/company', '/company/history', '/contact', '/orphan', '/redirect', '/spa', '/spa/detail',
  ].sort());
  // robots.txt で禁止されたページは対象外として記録し、開かない
  assert.deepEqual(r.paths('skipped'), ['/private/secret']);
  assert.equal(r.pages.find((p) => p.path === '/private/secret')!.skip_reason, 'robots');
  assert.ok(!site.requests.includes('/private/secret'));
  // 外部サイト・PDF・ログアウト・mailto は記録しない
  assert.ok(!r.pages.some((p) => /external|\.pdf|logout|mailto/.test(p.url)));
  assert.equal(r.paths('failed').length, 0);

  // 階層・リンク元・ステータス・転送先・画像
  const byPath = (path: string) => r.pages.find((p) => p.path === path)!;
  assert.equal(byPath('/').depth, 0);
  assert.equal(byPath('/blog/post-1').depth, 2);
  assert.equal(byPath('/blog/post-1').found_from_page_id, byPath('/blog').id);
  assert.equal(byPath('/orphan').depth, 1);
  assert.equal(byPath('/broken').http_status, 404);
  assert.match(byPath('/redirect').final_url!, /\/about\/$/);
  for (const p of r.pages.filter((p) => p.status === 'done')) {
    const shots = store.listShots(p.id);
    assert.equal(shots.length, 1);
    await access(shots[0]!.file_path);
  }
  assert.deepEqual([r.crawl.pages_done, r.crawl.pages_skipped, r.crawl.status], [r.paths('done').length, 1, 'done']);
  assert.deepEqual(r.events.at(-1), { type: 'crawl-finished', status: 'done' });
});

test('同じ階層は先頭 N 件だけ撮り、残りは間引きとして記録する（トップ直下は間引かない）', async () => {
  const r = await crawl('sample', { sampling: { mode: 'firstN', n: 2, prefixes: 'auto' } });
  const posts = r.pages.filter((p) => p.path.startsWith('/blog/post-'));
  assert.equal(posts.filter((p) => p.status === 'done').length, 2);
  assert.ok(posts.filter((p) => p.status === 'skipped').every((p) => p.skip_reason === 'sampling'));
  for (const top of ['/about', '/blog', '/contact', '/orphan', '/redirect', '/spa', '/broken']) assert.ok(r.paths('done').includes(top), top);
});

test('最大ページ数で打ち切り、残りは max-pages として記録する', async () => {
  const r = await crawl('max', { maxPages: 5 });
  assert.equal(r.paths('done').length, 5);
  assert.ok(r.pages.filter((p) => p.status === 'skipped').some((p) => p.skip_reason === 'max-pages'));
});

test('最大階層を指定すると、それより深いページはたどらない', async () => {
  const r = await crawl('depth', { maxDepth: 1, useSitemap: false });
  assert.ok(!r.pages.some((p) => p.path.startsWith('/blog/post-')));
  assert.ok(r.paths('done').includes('/blog'));
});

test('パラメータを別ページとして撮る設定では、?page=2 も撮る（追跡用パラメータは除く）', async () => {
  const r = await crawl('query', { keepQueryParams: true, maxDepth: 1, useSitemap: false });
  assert.ok(r.paths('done').includes('/blog?page=2'));
  assert.ok(!r.pages.some((p) => p.normalized_url.includes('utm_source')));
});

test('途中で止めると、撮影中のページを撮り終えて stopped で終わり、残りは queued のまま', async () => {
  const r = await crawl('stop', {}, (e, runner) => {
    if (e.type === 'page-done') runner.stop();
  });
  assert.equal(r.status, 'stopped');
  assert.ok(r.paths('done').length >= 1 && r.paths('done').length <= 2);
  assert.ok(r.paths('queued').length > 0);
  assert.equal(r.paths('capturing').length, 0);
});
