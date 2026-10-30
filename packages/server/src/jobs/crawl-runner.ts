import type { Browser, BrowserContext, BrowserContextOptions } from 'playwright';
import { BlockedError } from '../capture/blocked.js';
import { capturePage, createCaptureContext, NotHtmlError, PageTimeoutError } from '../capture/capture-page.js';
import { HostGate, withRateLimitRetry } from '../capture/host-gate.js';
import { viewportForWidth, type SiteSettings } from '../capture/types.js';
import { contextFetchText } from '../crawler/fetch-text.js';
import { normalizeUrl } from '../crawler/normalize.js';
import { loadRobots, type RobotsRules } from '../crawler/robots.js';
import { Sampler, groupKey } from '../crawler/sampling.js';
import { checkScope, isSameSite } from '../crawler/scope.js';
import { loadSitemapUrls } from '../crawler/sitemap.js';
import type { CrawlEvent, CrawlSettings, SkipReason } from '../crawler/types.js';
import type { CrawlStatus, Store } from '../db/store.js';
import { BUILTIN_PRESETS, findSiteSettings } from '../presets/index.js';

// 設計書 5.1「処理の流れ」: 1つの撮影セッション（起点URLから巡回して全ページを撮る）を実行する

type QueueItem = { pageId: number; url: string; depth: number };

class StoppedError extends Error {}

export type CrawlRunnerInput = {
  store: Store;
  browser: Browser;
  settings: CrawlSettings;
  outputDir: string;
  contextOptions?: BrowserContextOptions; // ログイン状態・Basic 認証（M4）
};

export class CrawlRunner {
  readonly crawlId: number;
  private readonly store: Store;
  private readonly settings: CrawlSettings;
  private readonly site: SiteSettings;
  private listeners: Array<(e: CrawlEvent) => void> = [];
  private queue: QueueItem[] = [];
  private admitted = 0;
  private sampler: Sampler;
  private robots: RobotsRules | null = null;
  private stopping = false;
  private stopSignal: Promise<void>;
  private resolveStop!: () => void;

  constructor(private readonly input: CrawlRunnerInput) {
    this.store = input.store;
    this.settings = input.settings;
    this.site = input.settings.siteSettingsName
      ? (BUILTIN_PRESETS.find((p) => p.name === input.settings.siteSettingsName) ?? findSiteSettings(input.settings.startUrl))
      : findSiteSettings(input.settings.startUrl);
    this.sampler = new Sampler(input.settings.sampling);
    this.crawlId = this.store.createCrawl(input.settings, input.outputDir);
    this.stopSignal = new Promise((resolve) => (this.resolveStop = resolve));
  }

  get siteSettings(): SiteSettings {
    return this.site;
  }

  subscribe(listener: (e: CrawlEvent) => void): () => void {
    this.listeners.push(listener);
    return () => (this.listeners = this.listeners.filter((l) => l !== listener));
  }

  // 撮影中のページは撮り終えてから止まる。新しいページには進まない（V-01）
  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.resolveStop();
  }

  async run(): Promise<CrawlStatus> {
    const { settings, store } = this;
    store.updateCrawlStatus(this.crawlId, 'running');
    let context: BrowserContext | null = null;
    let status: CrawlStatus = 'done';
    let errorMessage: string | null = null;
    try {
      context = await createCaptureContext(this.input.browser, this.input.contextOptions);
      const fetchText = contextFetchText(context);
      this.robots = await loadRobots(settings.startUrl, fetchText);

      // サイト設定（プリセット）はアクセスを控えめにする方向にだけ効かせる
      let intervalMs = Math.max(settings.intervalMs, this.site.intervalMs ?? 0);
      const concurrency = Math.max(1, Math.min(settings.concurrency, this.site.concurrency ?? Infinity));
      if (settings.respectRobotsTxt && this.robots.crawlDelaySec) {
        intervalMs = Math.max(intervalMs, this.robots.crawlDelaySec * 1000);
      }
      const gate = new HostGate(intervalMs, Date.now, (ms) => this.interruptibleSleep(ms));

      this.enqueue(settings.startUrl, 0, null);
      if (settings.useSitemap) {
        const urls = await loadSitemapUrls(settings.startUrl, this.robots.sitemaps, fetchText);
        for (const url of urls) this.enqueue(url, 1, null);
      }

      await this.runWorkers(context, gate, concurrency);
      status = this.stopping ? 'stopped' : 'done';
    } catch (e) {
      status = 'error';
      errorMessage = e instanceof Error ? e.message : String(e);
    } finally {
      await context?.close().catch(() => {});
      store.refreshCrawlCounts(this.crawlId);
      store.updateCrawlStatus(this.crawlId, status, errorMessage);
      this.emit({ type: 'crawl-finished', status });
    }
    return status;
  }

  private async runWorkers(context: BrowserContext, gate: HostGate, concurrency: number): Promise<void> {
    let inFlight = 0;
    // 待っているワーカー全員を起こす（キューが増えたか、全員の撮影が終わったかを確かめさせる）
    let waiters: Array<() => void> = [];
    const wakeAll = () => {
      const ws = waiters;
      waiters = [];
      for (const w of ws) w();
    };
    const worker = async () => {
      while (!this.stopping) {
        const item = this.queue.shift();
        if (!item) {
          // ほかのワーカーが撮影中なら、その結果で新しいページが増えるかもしれないので待つ
          if (inFlight === 0) break;
          await Promise.race([new Promise<void>((r) => waiters.push(r)), this.stopSignal]);
          continue;
        }
        inFlight++;
        try {
          await this.processPage(context, gate, item);
        } finally {
          inFlight--;
          wakeAll();
        }
      }
      wakeAll();
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  private async processPage(context: BrowserContext, gate: HostGate, item: QueueItem): Promise<void> {
    const { store, settings } = this;
    store.setPageStatus(item.pageId, 'capturing');
    this.emit({ type: 'page-started', pageId: item.pageId });
    const host = new URL(item.url).hostname;
    try {
      const result = await withRateLimitRetry(
        gate,
        host,
        async () => {
          if (this.stopping) throw new StoppedError();
          return capturePage({
            context,
            url: item.url,
            viewports: settings.viewports.map(viewportForWidth),
            outDir: this.input.outputDir,
            options: settings.capture,
            site: this.site,
            log: (message) => this.emit({ type: 'warning', message }),
          });
        },
        ({ error, waitSec }) =>
          this.emit({ type: 'warning', message: `アクセス制限（${error.reason}）のため ${waitSec}秒待機中: ${item.url}` }),
      );
      store.completePage(item.pageId, result);
      for (const s of result.shots) this.emit({ type: 'shot-done', pageId: item.pageId, width: s.viewportWidth, thumbPath: s.thumbPath });
      this.emit({ type: 'page-done', pageId: item.pageId, waitTimedOut: result.shots.some((s) => s.waitTimedOut) });

      if (item.depth === 0) this.warnIfLoginRedirect(item.url, result.finalUrl);

      // 転送された先が範囲外（外部サイト）なら、そのページのリンクはたどらない
      const finalHost = new URL(result.finalUrl).hostname;
      if (isSameSite(finalHost, new URL(settings.startUrl).hostname, settings.includeSubdomains)) {
        for (const link of result.links) this.enqueue(link, item.depth + 1, item.pageId);
      }
    } catch (e) {
      if (e instanceof StoppedError) {
        store.setPageStatus(item.pageId, 'queued');
      } else if (e instanceof NotHtmlError) {
        this.skip(item.pageId, 'not-html');
      } else {
        const message =
          e instanceof BlockedError
            ? `アクセス制限（${e.reason}）`
            : e instanceof PageTimeoutError
              ? `タイムアウト（${e.timeoutMs / 1000}秒）`
              : e instanceof Error
                ? e.message.split('\n')[0]!
                : String(e);
        store.setPageStatus(item.pageId, 'failed', { errorMessage: message });
        this.emit({ type: 'page-failed', pageId: item.pageId, error: message });
      }
    } finally {
      store.refreshCrawlCounts(this.crawlId);
    }
  }

  // 設計書 5.3: 範囲判定 → 重複判定 → robots.txt → 間引き → 最大ページ数 の順に判定してキューに入れる
  private enqueue(rawUrl: string, depth: number, fromPageId: number | null): void {
    const { settings, store } = this;
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return;
    }
    url.hash = '';
    if (!settings.keepQueryParams) url.search = '';
    if (checkScope(url.href, settings)) return;
    if (settings.maxDepth != null && depth > settings.maxDepth) return;
    const normalized = normalizeUrl(url.href, settings);
    if (store.hasPage(this.crawlId, normalized)) return;

    let skipReason: SkipReason | null = null;
    if (settings.respectRobotsTxt && this.robots && !this.robots.isAllowed(url.href)) skipReason = 'robots';
    else if (this.admitted >= settings.maxPages) skipReason = 'max-pages';
    else if (!this.sampler.admit(normalized)) skipReason = 'sampling';

    const pageId = store.insertPage({
      crawlId: this.crawlId,
      url: url.href,
      normalizedUrl: normalized,
      path: new URL(normalized).pathname,
      groupKey: groupKey(normalized),
      depth,
      foundFromPageId: fromPageId,
      status: skipReason ? 'skipped' : 'queued',
      skipReason,
    });
    if (pageId == null) return;
    this.emit({ type: 'page-found', pageId, url: url.href, depth });
    if (skipReason) {
      this.emit({ type: 'page-skipped', pageId, reason: skipReason });
      return;
    }
    this.admitted++;
    this.queue.push({ pageId, url: url.href, depth });
  }

  // 設計書 7.1: 起点ページがログイン画面に転送されたら、ログインが切れている可能性を知らせる
  private warnIfLoginRedirect(url: string, finalUrl: string): void {
    const looksLikeLogin = (u: string) => /(log-?in|sign-?in|auth)/i.test(new URL(u).pathname);
    if (finalUrl !== url && looksLikeLogin(finalUrl) && !looksLikeLogin(url)) {
      const hint = this.settings.authProfileId ? 'ログイン状態が切れている可能性があります。設定画面で作り直してください' : 'ログインが必要なサイトの場合は、ログイン状態を選んで撮影してください';
      this.emit({ type: 'warning', message: `起点のページがログイン画面（${finalUrl}）に転送されました。${hint}` });
    }
  }

  private skip(pageId: number, reason: SkipReason): void {
    this.store.setPageStatus(pageId, 'skipped', { skipReason: reason });
    this.emit({ type: 'page-skipped', pageId, reason });
  }

  private async interruptibleSleep(ms: number): Promise<void> {
    await Promise.race([new Promise((r) => setTimeout(r, ms)), this.stopSignal]);
  }

  private emit(e: CrawlEvent): void {
    for (const l of this.listeners) l(e);
  }
}
