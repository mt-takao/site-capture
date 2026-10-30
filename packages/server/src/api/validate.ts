import { DEFAULT_SITE_SETTINGS, defaultCrawlSettings, type CrawlSettings, type SiteSettings } from '@site-capture/shared';

// POST /api/crawls の本文を検証し、初期値と合わせた撮影設定にする。問題があれば日本語のメッセージを投げる

export class ValidationError extends Error {}

export function parseCrawlSettings(body: unknown): CrawlSettings {
  if (!body || typeof body !== 'object') throw new ValidationError('撮影設定がありません');
  // Basic 認証の ID・パスワードは撮影設定に入れない（保存しないため）。呼び出し側で別に受け取る
  const { basicAuth: _basicAuth, ...input } = body as Partial<CrawlSettings> & { basicAuth?: unknown };
  if (typeof input.startUrl !== 'string' || !input.startUrl.trim()) throw new ValidationError('URLを入力してください');

  let url: URL;
  try {
    url = new URL(input.startUrl.trim());
  } catch {
    throw new ValidationError('URLの形式が正しくありません');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ValidationError('http または https のURLを入力してください');

  const defaults = defaultCrawlSettings(url.href);
  const s: CrawlSettings = {
    ...defaults,
    ...input,
    startUrl: url.href,
    capture: { ...defaults.capture, ...(input.capture ?? {}) },
  };

  if (!Array.isArray(s.viewports) || s.viewports.length === 0) throw new ValidationError('画面幅を1つ以上選んでください');
  if (s.viewports.length > 6) throw new ValidationError('画面幅は6つまでです');
  s.viewports = [...new Set(s.viewports.map(Number))];
  if (s.viewports.some((w) => !Number.isInteger(w) || w < 200 || w > 3840)) {
    throw new ValidationError('画面幅は 200〜3840 の整数で指定してください');
  }
  requireInt(s.maxPages, 1, 5000, '最大ページ数');
  if (s.maxDepth != null) requireInt(s.maxDepth, 0, 100, '最大階層');
  requireInt(s.concurrency, 1, 5, '同時に開くページ数');
  requireInt(s.intervalMs, 0, 600000, 'アクセス間隔');
  requireInt(s.capture.extraWaitMs, 0, 60000, '撮影前の待ち時間');
  requireInt(s.capture.maxWaitMs, 1000, 120000, '最大待ち時間');
  if (s.sampling.mode === 'firstN') requireInt(s.sampling.n, 1, 1000, '間引きの件数');
  if (!Array.isArray(s.excludePatterns)) throw new ValidationError('除外パターンの形式が正しくありません');
  s.excludePatterns = s.excludePatterns.map(String).map((p) => p.trim()).filter(Boolean);
  if (s.authProfileId != null && typeof s.authProfileId !== 'string') throw new ValidationError('ログイン状態の指定が正しくありません');
  return s;
}

export function parseBasicAuth(body: unknown): { username: string; password: string } | null {
  const v = (body as { basicAuth?: unknown } | null)?.basicAuth;
  if (v == null) return null;
  const { username, password } = v as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') throw new ValidationError('Basic認証のIDとパスワードの形式が正しくありません');
  return username ? { username, password } : null;
}

function requireInt(v: unknown, min: number, max: number, label: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${label}は ${min}〜${max} の整数で指定してください`);
  }
}

// サイト設定（S-05, J-02, J-03, J-07）の入力を検証する。CSSセレクタの書き方までは確かめない（撮影時にブラウザが判定する）
export function parseSiteSettings(body: unknown): SiteSettings {
  if (!body || typeof body !== 'object') throw new ValidationError('サイト設定がありません');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new ValidationError('名前を入力してください');
  const hostPatterns = stringList(b.hostPatterns, '対象のホスト');
  if (hostPatterns.length === 0) throw new ValidationError('対象のホストを1つ以上入力してください（例: example.com、*.example.com）');
  for (const p of hostPatterns) {
    if (!/^(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(p) || p.includes('/')) {
      throw new ValidationError(`対象のホスト「${p}」の形式が正しくありません（例: example.com、*.example.com）`);
    }
  }
  const optionalText = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const optionalInt = (v: unknown, min: number, max: number, label: string) => {
    if (v == null || v === '') return undefined;
    requireInt(v, min, max, label);
    return v as number;
  };
  return {
    ...DEFAULT_SITE_SETTINGS,
    name,
    hostPatterns: hostPatterns.map((p) => p.toLowerCase()),
    waitForSelector: optionalText(b.waitForSelector),
    hideSelectors: stringList(b.hideSelectors, '隠す要素'),
    hideByText: stringList(b.hideByText, '文字列で隠す要素'),
    scrollContainerSelector: optionalText(b.scrollContainerSelector),
    beforeCaptureScript: optionalText(b.beforeCaptureScript),
    expandTogglesScript: optionalText(b.expandTogglesScript),
    reloadPerViewport: b.reloadPerViewport !== false,
    concurrency: optionalInt(b.concurrency, 1, 5, '同時に開くページ数'),
    intervalMs: optionalInt(b.intervalMs, 0, 600000, 'アクセス間隔'),
  };
}

function stringList(v: unknown, label: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new ValidationError(`${label}の形式が正しくありません`);
  return (v as string[]).map((x) => x.trim()).filter(Boolean);
}
