// 設計書 5.2「URLの正規化」（C-03, C-03a）

const TRACKING_PARAMS = /^(utm_.+|fbclid|gclid|yclid|mc_eid|_ga)$/i;
const INDEX_FILE = /\/index\.(html?|php)$/i;

export function normalizeUrl(input: string, options: { keepQueryParams: boolean }): string {
  const u = new URL(input);
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';

  if (options.keepQueryParams) {
    const params = [...u.searchParams.entries()]
      .filter(([k]) => !TRACKING_PARAMS.test(k))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    u.search = new URLSearchParams(params).toString();
  } else {
    u.search = '';
  }

  let path = u.pathname.replace(INDEX_FILE, '/');
  // /about と /about/ は同じページとみなす（ルート以外は末尾の / を取る）
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');
  u.pathname = path || '/';
  return u.href;
}
