import { DEFAULT_CAPTURE_OPTIONS, type CaptureOptions } from '../capture/types.js';

// 設計書 4.1「撮影設定」。撮影開始時の設定をまるごと crawls.settings_json に保存する

export type Sampling = { mode: 'all' } | { mode: 'firstN'; n: number; prefixes: string[] | 'auto' };

export type CrawlSettings = {
  startUrl: string;
  viewports: number[]; // 画面幅
  includeSubdomains: boolean; // C-02
  keepQueryParams: boolean; // C-03a
  sampling: Sampling; // C-03b
  maxPages: number; // C-04
  maxDepth: number | null; // C-05
  excludePatterns: string[]; // C-06, C-09
  useSitemap: boolean; // C-07
  concurrency: number; // C-11
  intervalMs: number; // C-11
  respectRobotsTxt: boolean;
  authProfileId: string | null; // L-01（M4）
  capture: CaptureOptions;
  siteSettingsName: string | null; // null なら起点URLから自動で選ぶ
};

// C-09: 押すと状態が変わるリンクを初期値で除外する
export const DEFAULT_EXCLUDE_PATTERNS = ['logout', 'signout', 'sign-out', 'log-out', 'delete', 'destroy'];

export function defaultCrawlSettings(startUrl: string): CrawlSettings {
  return {
    startUrl,
    viewports: [1440, 375],
    includeSubdomains: false,
    keepQueryParams: false,
    sampling: { mode: 'all' },
    maxPages: 200,
    maxDepth: null,
    excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
    useSitemap: true,
    concurrency: 2,
    intervalMs: 500,
    respectRobotsTxt: true,
    authProfileId: null,
    capture: { ...DEFAULT_CAPTURE_OPTIONS },
    siteSettingsName: null,
  };
}

// 8.1「進捗イベント」
export type SkipReason = 'not-html' | 'sampling' | 'max-pages' | 'robots';

export type CrawlEvent =
  | { type: 'page-found'; pageId: number; url: string; depth: number }
  | { type: 'page-started'; pageId: number }
  | { type: 'shot-done'; pageId: number; width: number; thumbPath: string }
  | { type: 'page-done'; pageId: number; waitTimedOut: boolean }
  | { type: 'page-failed'; pageId: number; error: string }
  | { type: 'page-skipped'; pageId: number; reason: SkipReason }
  | { type: 'crawl-finished'; status: 'done' | 'stopped' | 'error' }
  | { type: 'warning'; message: string };
