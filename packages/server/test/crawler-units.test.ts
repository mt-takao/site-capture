import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../src/crawler/normalize.js';
import { loadRobots } from '../src/crawler/robots.js';
import { Sampler, groupKey } from '../src/crawler/sampling.js';
import { checkScope, isSameSite, matchesExcludePattern } from '../src/crawler/scope.js';
import { loadSitemapUrls, parseSitemap } from '../src/crawler/sitemap.js';
import type { FetchText } from '../src/crawler/fetch-text.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../src/crawler/types.js';

const drop = { keepQueryParams: false };
const keep = { keepQueryParams: true };

test('正規化: # を除き、ホストを小文字にし、既定のポートと末尾の / と index.html をそろえる', () => {
  assert.equal(normalizeUrl('https://Example.COM:443/About/#team', drop), 'https://example.com/About');
  assert.equal(normalizeUrl('http://example.com:80/', drop), 'http://example.com/');
  assert.equal(normalizeUrl('https://example.com/about/', drop), normalizeUrl('https://example.com/about', drop));
  assert.equal(normalizeUrl('https://example.com/news/index.html', drop), 'https://example.com/news');
  assert.equal(normalizeUrl('https://example.com/index.html', drop), 'https://example.com/');
});

test('正規化: パラメータは設定に応じて消すか並べ替え、追跡用のパラメータは常に消す', () => {
  assert.equal(normalizeUrl('https://example.com/list?page=2', drop), 'https://example.com/list');
  assert.equal(normalizeUrl('https://example.com/list?b=2&a=1&utm_source=x', keep), 'https://example.com/list?a=1&b=2');
  assert.equal(normalizeUrl('https://example.com/list?utm_source=x&fbclid=y', keep), 'https://example.com/list');
});

test('範囲判定: 同じホストだけ。サブドメインは設定で含められる（co.jp のような2段のドメインも扱う）', () => {
  assert.ok(isSameSite('example.com', 'example.com', false));
  assert.ok(!isSameSite('shop.example.com', 'www.example.com', false));
  assert.ok(isSameSite('shop.example.com', 'www.example.com', true));
  assert.ok(isSameSite('example.com', 'www.example.com', true));
  assert.ok(isSameSite('shop.bm-sms.co.jp', 'www.bm-sms.co.jp', true));
  assert.ok(!isSameSite('other.co.jp', 'www.bm-sms.co.jp', true));
});

test('範囲判定: スキーム、除外パターン、HTML以外の拡張子', () => {
  const opts = { startUrl: 'https://example.com/', includeSubdomains: false, excludePatterns: DEFAULT_EXCLUDE_PATTERNS };
  assert.equal(checkScope('https://example.com/about', opts), null);
  assert.equal(checkScope('mailto:a@example.com', opts), 'scheme');
  assert.equal(checkScope('https://other.com/', opts), 'host');
  assert.equal(checkScope('https://example.com/account/logout', opts), 'excluded');
  assert.equal(checkScope('https://example.com/files/a.PDF', opts), 'non-html-extension');
});

test('除外パターン: * はワイルドカード、* なしは部分一致', () => {
  assert.ok(matchesExcludePattern('/blog/page/3', '/blog/page/*'));
  assert.ok(!matchesExcludePattern('/blog/post-1', '/blog/page/*'));
  assert.ok(matchesExcludePattern('/items?sort=asc', '?sort='));
  assert.ok(matchesExcludePattern('/User/LogOut', 'logout'));
});

test('間引き: 同じ階層は先頭 N 件。auto ではトップ直下を対象にしない', () => {
  assert.equal(groupKey('https://example.com/blog/2026/hello'), '/blog/2026/');
  assert.equal(groupKey('https://example.com/about'), '/');
  const auto = new Sampler({ mode: 'firstN', n: 2, prefixes: 'auto' });
  assert.deepEqual(['/blog/a', '/blog/b', '/blog/c', '/x', '/y', '/z'].map((p) => auto.admit(`https://e.com${p}`)), [
    true, true, false, true, true, true,
  ]);
  const blogOnly = new Sampler({ mode: 'firstN', n: 1, prefixes: ['/blog'] });
  assert.deepEqual(['/blog/a', '/blog/b', '/news/a', '/news/b'].map((p) => blogOnly.admit(`https://e.com${p}`)), [
    true, false, true, true,
  ]);
});

test('サイトマップ: URL 一覧と索引を読み分ける', () => {
  assert.deepEqual(parseSitemap('<urlset><url><loc> https://e.com/a?x=1&amp;y=2 </loc></url><url><loc><![CDATA[https://e.com/b]]></loc></url></urlset>'), {
    kind: 'urlset',
    locs: ['https://e.com/a?x=1&y=2', 'https://e.com/b'],
  });
  assert.equal(parseSitemap('<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>').kind, 'index');
});

function fakeFetch(files: Record<string, string>): FetchText {
  return async (url) => (url in files ? { status: 200, text: files[url]! } : { status: 404, text: '' });
}

test('サイトマップ: 索引の中のサイトマップもたどり、robots.txt に書かれたものも読む', async () => {
  const urls = await loadSitemapUrls(
    'https://e.com/',
    ['https://e.com/extra.xml'],
    fakeFetch({
      'https://e.com/sitemap.xml': '<sitemapindex><sitemap><loc>https://e.com/s1.xml</loc></sitemap></sitemapindex>',
      'https://e.com/s1.xml': '<urlset><url><loc>https://e.com/a</loc></url></urlset>',
      'https://e.com/extra.xml': '<urlset><url><loc>https://e.com/b</loc></url></urlset>',
    }),
  );
  assert.deepEqual(urls.sort(), ['https://e.com/a', 'https://e.com/b']);
});

test('robots.txt: 禁止されたパス、Crawl-delay、サイトマップを読む。無ければ制限なし', async () => {
  const rules = await loadRobots(
    'https://e.com/',
    fakeFetch({ 'https://e.com/robots.txt': 'User-agent: *\nDisallow: /private/\nCrawl-delay: 3\nSitemap: https://e.com/s.xml\n' }),
  );
  assert.ok(rules.isAllowed('https://e.com/about'));
  assert.ok(!rules.isAllowed('https://e.com/private/x'));
  assert.equal(rules.crawlDelaySec, 3);
  assert.deepEqual(rules.sitemaps, ['https://e.com/s.xml']);
  const none = await loadRobots('https://e.com/', fakeFetch({}));
  assert.ok(none.isAllowed('https://e.com/private/x'));
});
