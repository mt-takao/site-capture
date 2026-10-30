import { getDomain } from 'tldts';

// 設計書 5.3「範囲判定」（C-02, C-05, C-06, C-09, C-10）。robots.txt の判定は robots.ts

const NON_HTML_EXTENSIONS =
  /\.(pdf|zip|gz|tgz|rar|7z|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|mov|webm|avi|mp3|wav|m4a|ogg|docx?|xlsx?|pptx?|csv|txt|xml|json|js|css|woff2?|ttf|otf|eot|dmg|exe|apk)$/i;

export type ScopeOptions = {
  startUrl: string;
  includeSubdomains: boolean;
  excludePatterns: string[];
};

export type OutOfScopeReason = 'scheme' | 'host' | 'excluded' | 'non-html-extension';

export function checkScope(url: string, options: ScopeOptions): OutOfScopeReason | null {
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'scheme';
  if (!isSameSite(u.hostname, new URL(options.startUrl).hostname, options.includeSubdomains)) return 'host';
  const target = `${u.pathname}${u.search}`;
  if (options.excludePatterns.some((p) => matchesExcludePattern(target, p))) return 'excluded';
  if (NON_HTML_EXTENSIONS.test(u.pathname)) return 'non-html-extension';
  return null;
}

export function isSameSite(host: string, startHost: string, includeSubdomains: boolean): boolean {
  const h = host.toLowerCase();
  const s = startHost.toLowerCase();
  if (h === s) return true;
  if (!includeSubdomains) return false;
  // 起点の登録ドメイン（例: www.example.co.jp → example.co.jp）の配下なら可
  const registrable = getDomain(s) ?? s;
  return h === registrable || h.endsWith(`.${registrable}`);
}

// 除外パターン（C-06）: `*` を含むものはパス＋クエリ全体へのワイルドカード、含まないものは部分一致
export function matchesExcludePattern(pathAndQuery: string, pattern: string): boolean {
  const p = pattern.trim();
  if (!p) return false;
  if (!p.includes('*')) return pathAndQuery.toLowerCase().includes(p.toLowerCase());
  const re = new RegExp(`^${p.split('*').map(escapeRegExp).join('.*')}$`, 'i');
  return re.test(pathAndQuery);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
