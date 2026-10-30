import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db/store.js';
import { defaultCrawlSettings } from '../src/crawler/types.js';

test('データベース: 作成、ページの重複防止、撮影結果の保存、集計、途中停止の扱い', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'site-capture-db-'));
  try {
    const path = join(dir, 'test.db');
    let store = new Store(path);
    const crawlId = store.createCrawl(defaultCrawlSettings('https://e.com/'), '/tmp/out');
    store.updateCrawlStatus(crawlId, 'running');
    const base = { crawlId, path: '/', groupKey: '/', depth: 0, foundFromPageId: null, status: 'queued' as const };
    const p1 = store.insertPage({ ...base, url: 'https://e.com/', normalizedUrl: 'https://e.com/' })!;
    assert.equal(store.insertPage({ ...base, url: 'https://e.com/#x', normalizedUrl: 'https://e.com/' }), null);
    store.insertPage({ ...base, url: 'https://e.com/a', normalizedUrl: 'https://e.com/a', status: 'skipped', skipReason: 'robots' });
    store.setPageStatus(p1, 'capturing');
    store.completePage(p1, {
      httpStatus: 200,
      title: 'トップ',
      finalUrl: 'https://e.com/',
      shots: [{ viewportWidth: 1440, filePath: '/tmp/out/index__1440.png', thumbPath: '/tmp/t.webp', imageWidth: 1440, imageHeight: 2000, method: 'fullpage', fellBackToStitch: false, waitTimedOut: true }],
    });
    store.refreshCrawlCounts(crawlId);
    const crawl = store.getCrawl(crawlId)!;
    assert.deepEqual([crawl.pages_found, crawl.pages_done, crawl.pages_skipped], [2, 1, 1]);
    assert.equal(store.listPages(crawlId, 'done')[0]!.wait_timed_out, 1);
    assert.equal(store.listShots(p1).length, 1);
    store.close();

    // 開き直しても中身が残り、running のままだった撮影は stopped になる
    store = new Store(path);
    assert.equal(store.markInterruptedCrawls(), 1);
    assert.equal(store.getCrawl(crawlId)!.status, 'stopped');
    store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
