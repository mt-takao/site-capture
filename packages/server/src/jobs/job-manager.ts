import type { Browser } from 'playwright';
import type { CrawlEvent, CrawlSettings } from '@site-capture/shared';
import type { Store } from '../db/store.js';
import { captureDir } from '../paths.js';
import { CrawlRunner } from './crawl-runner.js';

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

  async start(settings: CrawlSettings): Promise<{ crawlId: number; finished: Promise<void> }> {
    this.browser ??= this.launchBrowser();
    const browser = await this.browser;
    const runner = new CrawlRunner({ store: this.store, browser, settings, outputDir: this.outputDirFor(settings) });
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

  isRunning(id: number): boolean {
    return this.runners.has(id);
  }

  siteSettingsName(id: number): string | null {
    return this.runners.get(id)?.siteSettings.name ?? null;
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
