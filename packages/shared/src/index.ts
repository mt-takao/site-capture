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
  siteSettingsId: string | null; // 使うサイト設定。null なら起点URLから自動で選ぶ
  usesBasicAuth?: boolean; // Basic 認証を使ったか（ID とパスワードは保存しない。撮り直すときに入力し直してもらうため）
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
    siteSettingsId: null,
  };
}

// ---- サイト設定（設計書 4.1、6.5。S-05, J-02, J-03, J-07, J-08） ----

export type SiteSettings = {
  name: string;
  hostPatterns: string[]; // 例: ['*.notion.site']
  waitForSelector?: string; // J-02
  hideSelectors: string[]; // S-05
  hideByText: string[]; // S-05 文字列で探して隠す
  scrollContainerSelector?: string; // J-03（手動指定）
  beforeCaptureScript?: string; // J-07
  expandTogglesScript?: string; // J-09（expandToggles が true のときだけ実行）
  reloadPerViewport: boolean; // 画面幅ごとに開き直すか（設計書 6.1）
  concurrency?: number; // C-11 の上書き
  intervalMs?: number; // C-11 の上書き
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = {
  name: '標準',
  hostPatterns: [],
  hideSelectors: [],
  hideByText: [],
  reloadPerViewport: true,
};

// builtin: 組み込みのプリセット（編集・削除できない）
export type SiteSettingsItem = SiteSettings & { id: string; builtin: boolean };

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
  siteSettingsName: string; // 撮影開始時に使ったサイト設定の名前
  authProfileName: string | null; // 使ったログイン状態（削除済みなら null）
  warnings: string[]; // 撮影中に出た警告（ログイン切れ、アクセス制限など）
  retryableCount: number; // 撮り直せるページ数（失敗と、止めたときに残った撮影待ち）
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

// ---- 比較（V-05, V-05b、設計書 9.4） ----

// both: 両方にある、added: B（新しいほう）にだけある、removed: A（古いほう）にだけある
export type ComparePairStatus = 'both' | 'added' | 'removed';

export type ComparePair = {
  key: string; // 組み合わせに使ったパス（クエリ付き）
  status: ComparePairStatus;
  a: PageItem | null;
  b: PageItem | null;
};

export type CompareResult = {
  a: CrawlSummary;
  b: CrawlSummary;
  commonWidths: number[]; // 両方で撮った画面幅（広い順）
  pairs: ComparePair[];
};

// ---- ログイン（設計書 7章） ----

// 撮影開始の要求。Basic 認証（L-04）の ID・パスワードは撮影設定とは別に受け取り、保存しない
export type StartCrawlRequest = Partial<CrawlSettings> & {
  basicAuth?: { username: string; password: string } | null;
};

export type AuthProfileItem = {
  id: string;
  name: string;
  origin: string; // 例: https://example.com
  createdAt: string;
  lastUsedAt: string | null;
};

// ログイン用ブラウザ。open: 開いている、closed: 利用者がウィンドウを閉じた
export type LoginSessionInfo = {
  id: string;
  name: string;
  url: string;
  status: 'open' | 'closed';
};

// SSE で送るメッセージ。つないだ直後に snapshot を送り、その後は CrawlEvent を送る
export type StreamMessage = { type: 'snapshot'; crawl: CrawlDetail } | CrawlEvent;

export type ApiError = { error: string };
