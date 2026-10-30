import robotsParserModule from 'robots-parser';
import type { FetchText } from './fetch-text.js';

// robots.txt を読み、巡回してよいURLか、指定された待ち時間（Crawl-delay）、サイトマップの場所を返す

// robots-parser は CommonJS だが型定義が ESM の default export になっている。実行時の default（関数）に合わせて型を付け直す
const robotsParser = robotsParserModule as unknown as typeof robotsParserModule.default;

const USER_AGENT = 'SiteCapture';

export type RobotsRules = {
  isAllowed: (url: string) => boolean;
  crawlDelaySec: number | null;
  sitemaps: string[];
};

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, crawlDelaySec: null, sitemaps: [] };

export async function loadRobots(startUrl: string, fetchText: FetchText): Promise<RobotsRules> {
  const robotsUrl = new URL('/robots.txt', startUrl).href;
  const res = await fetchText(robotsUrl);
  // 取得できない・存在しない場合は制限なしとして扱う
  if (!res || res.status >= 400) return ALLOW_ALL;
  const robots = robotsParser(robotsUrl, res.text);
  return {
    isAllowed: (url) => robots.isAllowed(url, USER_AGENT) ?? true,
    crawlDelaySec: robots.getCrawlDelay(USER_AGENT) ?? null,
    sitemaps: robots.getSitemaps(),
  };
}
