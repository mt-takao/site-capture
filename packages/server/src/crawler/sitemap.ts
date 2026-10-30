import type { FetchText } from './fetch-text.js';

// C-07: sitemap.xml（と robots.txt に書かれたサイトマップ）に載っているURLを集める。
// サイトマップの索引（sitemapindex）は中のサイトマップもたどる。読みすぎないよう上限を設ける

const MAX_SITEMAP_FILES = 20;
const MAX_URLS = 5000;

export async function loadSitemapUrls(startUrl: string, extraSitemaps: string[], fetchText: FetchText): Promise<string[]> {
  const queue = [new URL('/sitemap.xml', startUrl).href, ...extraSitemaps];
  const seen = new Set<string>();
  const urls = new Set<string>();

  while (queue.length > 0 && seen.size < MAX_SITEMAP_FILES && urls.size < MAX_URLS) {
    const sitemapUrl = queue.shift()!;
    if (seen.has(sitemapUrl)) continue;
    seen.add(sitemapUrl);
    // 圧縮されたサイトマップ（.xml.gz）は扱わない
    if (sitemapUrl.endsWith('.gz')) continue;
    const res = await fetchText(sitemapUrl);
    if (!res || res.status >= 400) continue;

    const parsed = parseSitemap(res.text);
    if (parsed.kind === 'index') queue.push(...parsed.locs);
    else for (const loc of parsed.locs) if (urls.size < MAX_URLS) urls.add(loc);
  }
  return [...urls];
}

export function parseSitemap(xml: string): { kind: 'index' | 'urlset'; locs: string[] } {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? 'index' : 'urlset';
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)]
    .map((m) => decodeXmlEntities(m[1]!))
    .filter((u) => /^https?:\/\//i.test(u));
  return { kind, locs };
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
