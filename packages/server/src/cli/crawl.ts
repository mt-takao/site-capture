// 起点URLからサイト内を巡回して全ページを撮る（M2 の完了条件「数十ページのサイトを全部撮れる」）。
// 使い方: pnpm crawl <URL> [オプション]   オプションは --help で表示
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { defaultCrawlSettings, type CrawlSettings } from '../crawler/types.js';
import { Store } from '../db/store.js';
import { CrawlRunner } from '../jobs/crawl-runner.js';
import { captureDir, databasePath } from '../paths.js';

const HELP = `使い方: pnpm crawl <URL> [オプション]
  --widths 1440,375         画面幅（カンマ区切り）
  --max-pages 200           撮る最大ページ数
  --max-depth <n>           起点からリンクをたどる最大回数（初期値: 制限なし）
  --include-subdomains      サブドメインも巡回する
  --keep-query              パラメータだけが違うURLを別ページとして撮る
  --sample <n>              同じ階層のページは先頭 n 件だけ撮る（トップ直下は除く）
  --exclude <パターン>      除外するURLのパターン（複数指定可。* でワイルドカード）
  --no-sitemap              sitemap.xml を使わない
  --ignore-robots           robots.txt の禁止に従わない
  --concurrency 2           同時に開くページ数
  --interval 500            同じサイトへのアクセス間隔（ミリ秒）
  --expand-toggles          Notion のトグルを開いて撮る
  --out <フォルダ>          画像の保存先`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    widths: { type: 'string' },
    'max-pages': { type: 'string' },
    'max-depth': { type: 'string' },
    'include-subdomains': { type: 'boolean', default: false },
    'keep-query': { type: 'boolean', default: false },
    sample: { type: 'string' },
    exclude: { type: 'string', multiple: true, default: [] },
    'no-sitemap': { type: 'boolean', default: false },
    'ignore-robots': { type: 'boolean', default: false },
    concurrency: { type: 'string' },
    interval: { type: 'string' },
    'expand-toggles': { type: 'boolean', default: false },
    out: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
});

const startUrl = positionals[0];
if (!startUrl || values.help) {
  console.log(HELP);
  process.exit(startUrl ? 0 : 2);
}

const defaults = defaultCrawlSettings(startUrl);
const settings: CrawlSettings = {
  ...defaults,
  viewports: values.widths ? values.widths.split(',').map(Number).filter((w) => w > 0) : defaults.viewports,
  maxPages: values['max-pages'] ? Number(values['max-pages']) : defaults.maxPages,
  maxDepth: values['max-depth'] ? Number(values['max-depth']) : null,
  includeSubdomains: values['include-subdomains'],
  keepQueryParams: values['keep-query'],
  sampling: values.sample ? { mode: 'firstN', n: Number(values.sample), prefixes: 'auto' } : { mode: 'all' },
  excludePatterns: [...defaults.excludePatterns, ...values.exclude],
  useSitemap: !values['no-sitemap'],
  respectRobotsTxt: !values['ignore-robots'],
  concurrency: values.concurrency ? Number(values.concurrency) : defaults.concurrency,
  intervalMs: values.interval ? Number(values.interval) : defaults.intervalMs,
  capture: { ...defaults.capture, expandToggles: values['expand-toggles'] },
};

const dbPath = databasePath();
mkdirSync(dirname(dbPath), { recursive: true });
const store = new Store(dbPath);
store.markInterruptedCrawls();
const outputDir = values.out ?? captureDir(new URL(startUrl).hostname, new Date());
const browser = await chromium.launch();
const runner = new CrawlRunner({ store, browser, settings, outputDir });

console.log(`撮影セッション #${runner.crawlId}: ${startUrl}`);
console.log(`サイト設定: ${runner.siteSettings.name} / 画面幅: ${settings.viewports.join(', ')} / 保存先: ${outputDir}`);
console.log('Ctrl + C で停止（撮影中のページは撮り終えてから止まります。もう一度押すとすぐ終了）');

const urls = new Map<number, string>();
const startedAt = Date.now();
const counts = { done: 0, failed: 0, skipped: 0 };
runner.subscribe((e) => {
  const t = `[${((Date.now() - startedAt) / 1000).toFixed(0).padStart(4)}s]`;
  switch (e.type) {
    case 'page-found':
      urls.set(e.pageId, e.url);
      break;
    case 'page-done':
      counts.done++;
      console.log(`${t} ✓ ${urls.get(e.pageId)}${e.waitTimedOut ? '（待ちきれずに撮影）' : ''}`);
      break;
    case 'page-failed':
      counts.failed++;
      console.log(`${t} ✗ ${urls.get(e.pageId)}: ${e.error}`);
      break;
    case 'page-skipped':
      counts.skipped++;
      if (e.reason !== 'max-pages') console.log(`${t} - ${urls.get(e.pageId)}（対象外: ${e.reason}）`);
      break;
    case 'warning':
      console.log(`${t} ! ${e.message}`);
      break;
  }
});

let interrupts = 0;
process.on('SIGINT', () => {
  if (++interrupts > 1) process.exit(130);
  console.log('\n停止しています…（撮影中のページを撮り終えるまで待ちます）');
  runner.stop();
});

const status = await runner.run();
await browser.close();
const crawl = store.getCrawl(runner.crawlId)!;
store.close();
console.log(
  `\n結果: ${status} / 見つけたページ ${crawl.pages_found} / 撮影 ${crawl.pages_done} / 失敗 ${crawl.pages_failed} / 対象外 ${crawl.pages_skipped}` +
    ` / 所要時間 ${((Date.now() - startedAt) / 1000).toFixed(0)}秒`,
);
if (crawl.error_message) console.log(`エラー: ${crawl.error_message}`);
process.exitCode = status === 'error' ? 1 : 0;
