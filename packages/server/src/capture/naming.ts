import { createHash } from 'node:crypto';

// 設計書 5章「ファイル名」: `<パスを_でつないだ文字列>__<画面幅>.png`
// 例: https://example.com/about/company → about_company、トップページ → index。
// クエリがあるURLは、別ページとして撮る設定（C-03a）のときに衝突しないよう短いハッシュを付ける。

const MAX_BASE_LENGTH = 120;

export function fileBaseForUrl(url: string): string {
  const u = new URL(url);
  const segments = u.pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => safeSegment(s))
    .filter((s) => s.length > 0);
  let base = segments.length === 0 ? 'index' : segments.join('_');
  if (base.length > MAX_BASE_LENGTH) base = `${base.slice(0, MAX_BASE_LENGTH)}_${shortHash(u.pathname)}`;
  if (u.search.length > 1) base += `_q${shortHash(u.search)}`;
  return base;
}

// 要素を押してから撮った画像には、押した要素の通し番号（1 から）を付ける。例: index__click-2__1440.png
export function shotFileName(url: string, viewportWidth: number, clickNo?: number): string {
  const click = clickNo == null ? '' : `__click-${clickNo}`;
  return `${fileBaseForUrl(url)}${click}__${viewportWidth}.png`;
}

function safeSegment(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return decoded
    .replace(/\.(html?|php|aspx?)$/i, '')
    .replace(/[\\/:*?"<>|\s_]+/g, '-') // ファイル名に使えない文字と区切りの _ は - にする
    .replace(/^-+|-+$/g, '');
}

function shortHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}
