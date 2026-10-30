// サーバーと画面で共通の型と初期値（設計書 4.1、8章）

// ---- 撮影設定（設計書 4.1） ----

export type CaptureOptions = {
  extraWaitMs: number; // S-04
  quietWindowMs: number; // J-01
  maxWaitMs: number; // J-01
  pageTimeoutMs: number; // 1画面幅あたりの上限
  disableAnimations: boolean; // S-06
  expandToggles: boolean; // J-09
};

export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  extraWaitMs: 1000,
  quietWindowMs: 1000,
  maxWaitMs: 15000,
  pageTimeoutMs: 30000,
  disableAnimations: true,
  expandToggles: false,
};

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

// ---- 進捗イベント（設計書 8.1） ----

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

// ---- API の入出力（設計書 8章） ----

export type CrawlStatus = 'queued' | 'running' | 'done' | 'stopped' | 'error';
export type PageStatus = 'queued' | 'capturing' | 'done' | 'failed' | 'skipped';

export type CrawlCounts = { found: number; done: number; failed: number; skipped: number };

export type CrawlSummary = {
  id: number;
  startUrl: string;
  host: string;
  status: CrawlStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  counts: CrawlCounts;
  viewports: number[];
  thumbUrl: string | null; // 代表サムネイル
};

export type CrawlDetail = CrawlSummary & {
  settings: CrawlSettings;
  siteSettingsName: string;
  outputDir: string;
  errorMessage: string | null;
};

export type ShotItem = {
  id: number;
  viewportWidth: number;
  imageUrl: string;
  thumbUrl: string;
  imageWidth: number;
  imageHeight: number;
  method: 'fullpage' | 'tiled' | 'expand' | 'stitch';
  fellBack: boolean;
};

export type PageItem = {
  id: number;
  url: string;
  path: string;
  depth: number;
  status: PageStatus;
  skipReason: SkipReason | null;
  httpStatus: number | null;
  title: string | null;
  finalUrl: string | null;
  errorMessage: string | null;
  waitTimedOut: boolean;
  shots: ShotItem[];
};

export type SiteSettingsInfo = {
  name: string;
  hostPatterns: string[];
  reloadPerViewport: boolean;
  concurrency: number | null;
  intervalMs: number | null;
};

// SSE で送るメッセージ。つないだ直後に snapshot を送り、その後は CrawlEvent を送る
export type StreamMessage = { type: 'snapshot'; crawl: CrawlDetail } | CrawlEvent;

export type ApiError = { error: string };
