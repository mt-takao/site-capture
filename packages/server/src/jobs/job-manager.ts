import { existsSync } from 'node:fs';
import type { Browser, BrowserContextOptions } from 'playwright';
import type { CrawlEvent, CrawlSettings } from '@site-capture/shared';
import type { Store } from '../db/store.js';
import { captureDir } from '../paths.js';
import { CrawlRunner } from './crawl-runner.js';

export class StartCrawlError extends Error {}

// 撮影セッションを裏で実行し、進捗イベントを購読者（SSE の接続）に中継する。
// ブラウザは最初の撮影のときに起動し、以降は使い回す

export class JobManager {
  private runners = new Map<number, CrawlRunner>();
  private listeners = new Map<number, Set<(e: CrawlEvent) => void>>();
  private browser: Promise<Browser> | null = null;

  constructor(
    private readonly store: Store,
    private readonly launchBrowser: () => Promise<Browser>,
    private readonly outputDirFor: (settings: CrawlSettings) => string = (s) =>
      captureDir(new URL(s.startUrl).hostname, new Date()),
  ) {}

  async start(
    settings: CrawlSettings,
    secrets: { basicAuth?: { username: string; password: string } | null } = {},
  ): Promise<{ crawlId: number; finished: Promise<void> }> {
    const contextOptions = this.contextOptionsFor(settings, secrets.basicAuth ?? null);
    this.browser ??= this.launchBrowser();
    const browser = await this.browser;
    const runner = new CrawlRunner({ store: this.store, browser, settings, outputDir: this.outputDirFor(settings), contextOptions });
    if (settings.authProfileId) this.store.touchAuthProfile(settings.authProfileId);
    return this.launch(runner);
  }

  // S-08: 失敗したページと、止めたときに残った撮影待ちのページを、同じ撮影セッションの中で撮り直す。
  // Basic 認証は保存していないので、使う場合は撮り直すときにもう一度受け取る
  async retry(
    crawlId: number,
    secrets: { basicAuth?: { username: string; password: string } | null } = {},
  ): Promise<{ crawlId: number; finished: Promise<void> }> {
    if (this.runners.has(crawlId)) throw new StartCrawlError('この撮影は実行中です');
    const row = this.store.getCrawl(crawlId);
    if (!row) throw new StartCrawlError('撮影セッションが見つかりません');
    if (this.store.countRetryable(crawlId) === 0) throw new StartCrawlError('撮り直すページがありません');
    const settings = JSON.parse(row.settings_json) as CrawlSettings;
    const contextOptions = this.contextOptionsFor(settings, secrets.basicAuth ?? null);
    this.browser ??= this.launchBrowser();
    const browser = await this.browser;
    this.store.prepareRetry(crawlId);
    const runner = new CrawlRunner({ store: this.store, browser, resumeCrawlId: crawlId, contextOptions });
    if (settings.authProfileId) this.store.touchAuthProfile(settings.authProfileId);
    return this.launch(runner);
  }

  private launch(runner: CrawlRunner): { crawlId: number; finished: Promise<void> } {
    const id = runner.crawlId;
    this.runners.set(id, runner);
    runner.subscribe((e) => {
      for (const l of this.listeners.get(id) ?? []) l(e);
    });
    const finished = runner.run().then(
      () => {},
      () => {},
    );
    void finished.finally(() => this.runners.delete(id));
    return { crawlId: id, finished };
  }

  // ログイン状態（L-01）と Basic 認証（L-04）をブラウザコンテキストの設定にする
  private contextOptionsFor(
    settings: CrawlSettings,
    basicAuth: { username: string; password: string } | null,
  ): BrowserContextOptions {
    const options: BrowserContextOptions = {};
    if (settings.authProfileId) {
      const profile = this.store.getAuthProfile(settings.authProfileId);
      if (!profile || !existsSync(profile.storage_state_path)) {
        throw new StartCrawlError('選んだログイン状態が見つかりません。設定画面で作り直してください');
      }
      options.storageState = profile.storage_state_path;
    }
    if (basicAuth && basicAuth.username) {
      // ID とパスワードは起点URLと同じオリジンにだけ送る。外部サイトへの通信に送らないため
      options.httpCredentials = { ...basicAuth, origin: new URL(settings.startUrl).origin };
    }
    return options;
  }

  isRunning(id: number): boolean {
    return this.runners.has(id);
  }

  stop(id: number): boolean {
    const runner = this.runners.get(id);
    runner?.stop();
    return !!runner;
  }

  subscribe(id: number, listener: (e: CrawlEvent) => void): () => void {
    let set = this.listeners.get(id);
    if (!set) this.listeners.set(id, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }

  // サーバーを止めるとき: 実行中の撮影を止め、終わるのを待ってからブラウザを閉じる
  async shutdown(): Promise<void> {
    const running = [...this.runners.values()];
    for (const r of running) r.stop();
    await Promise.all(
      running.map(
        (r) =>
          new Promise<void>((resolve) => {
            if (!this.runners.has(r.crawlId)) return resolve();
            r.subscribe((e) => e.type === 'crawl-finished' && resolve());
          }),
      ),
    );
    if (this.browser) await (await this.browser).close();
  }
}
