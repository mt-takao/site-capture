import { defaultCrawlSettings, type CrawlSettings } from '@site-capture/shared';

// POST /api/crawls の本文を検証し、初期値と合わせた撮影設定にする。問題があれば日本語のメッセージを投げる

export class ValidationError extends Error {}

export function parseCrawlSettings(body: unknown): CrawlSettings {
  if (!body || typeof body !== 'object') throw new ValidationError('撮影設定がありません');
  const input = body as Partial<CrawlSettings>;
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
  return s;
}

function requireInt(v: unknown, min: number, max: number, label: string): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ValidationError(`${label}は ${min}〜${max} の整数で指定してください`);
  }
}
