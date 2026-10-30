import type { CrawlStatus, PageItem, PageStatus, ShotItem, SkipReason } from '@site-capture/shared';

// 画面に出す文言をまとめる

export const crawlStatusLabel: Record<CrawlStatus, string> = {
  queued: '待機中',
  running: '撮影中',
  done: '完了',
  stopped: '停止',
  error: 'エラー',
};

export const pageStatusLabel: Record<PageStatus, string> = {
  queued: '待機中',
  capturing: '撮影中',
  done: '撮影済み',
  failed: '失敗',
  skipped: '対象外',
};

export const skipReasonLabel: Record<SkipReason, string> = {
  'not-html': 'HTML以外',
  sampling: '間引き',
  'max-pages': '最大ページ数を超えた',
  robots: 'robots.txt で禁止',
};

export const shotMethodLabel: Record<ShotItem['method'], string> = {
  fullpage: 'フルページ撮影',
  tiled: '分割して結合',
  expand: '展開方式',
  stitch: 'つなぎ合わせ方式',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const sec = Math.max(0, Math.round(((endIso ? new Date(endIso) : new Date()).getTime() - new Date(startIso).getTime()) / 1000));
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  return min < 60 ? `${min}分${sec % 60}秒` : `${Math.floor(min / 60)}時間${min % 60}分`;
}

// ページ一覧の見出しに使う名前。タイトルがなければパス
export function pageName(p: PageItem): string {
  return p.title?.trim() || p.path;
}

export function shotFor(p: PageItem, width: number): ShotItem | undefined {
  return p.shots.find((s) => s.viewportWidth === width) ?? p.shots[0];
}
