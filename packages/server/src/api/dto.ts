import type { ComparePair, CompareResult, CrawlDetail, CrawlSettings, CrawlSummary, PageItem, ShotItem } from '@site-capture/shared';
import type { CrawlRow, PageRow, ShotRow, Store } from '../db/store.js';
import { BUILTIN_PRESETS, findSiteSettings } from '../presets/index.js';

// データベースの行を API の形（packages/shared の型）に変える

export function shotItem(row: ShotRow): ShotItem {
  return {
    id: row.id,
    viewportWidth: row.viewport_width,
    imageUrl: `/api/shots/${row.id}/image`,
    thumbUrl: `/api/shots/${row.id}/thumb`,
    imageWidth: row.image_width,
    imageHeight: row.image_height,
    method: row.method as ShotItem['method'],
    fellBack: row.fell_back === 1,
  };
}

export function crawlSummary(row: CrawlRow, store: Store): CrawlSummary {
  const settings = JSON.parse(row.settings_json) as CrawlSettings;
  const thumb = store.representativeShot(row.id);
  return {
    id: row.id,
    startUrl: row.start_url,
    host: new URL(row.start_url).host,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    counts: { found: row.pages_found, done: row.pages_done, failed: row.pages_failed, skipped: row.pages_skipped },
    viewports: settings.viewports,
    thumbUrl: thumb ? `/api/shots/${thumb.id}/thumb` : null,
  };
}

export function crawlDetail(row: CrawlRow, store: Store): CrawlDetail {
  const settings = JSON.parse(row.settings_json) as CrawlSettings;
  const site = settings.siteSettingsName
    ? (BUILTIN_PRESETS.find((p) => p.name === settings.siteSettingsName) ?? findSiteSettings(settings.startUrl))
    : findSiteSettings(settings.startUrl);
  const profile = settings.authProfileId ? store.getAuthProfile(settings.authProfileId) : undefined;
  return {
    ...crawlSummary(row, store),
    settings,
    siteSettingsName: site.name,
    authProfileName: profile?.name ?? null,
    outputDir: row.output_dir,
    errorMessage: row.error_message,
  };
}

export function pageItems(crawlId: number, store: Store): PageItem[] {
  const shotsByPage = new Map<number, ShotItem[]>();
  for (const s of store.listShotsForCrawl(crawlId)) {
    const list = shotsByPage.get(s.page_id) ?? [];
    list.push(shotItem(s));
    shotsByPage.set(s.page_id, list);
  }
  return store.listPages(crawlId).map((p: PageRow) => ({
    id: p.id,
    url: p.url,
    path: new URL(p.normalized_url).pathname + new URL(p.normalized_url).search,
    depth: p.depth,
    status: p.status,
    skipReason: p.skip_reason,
    httpStatus: p.http_status,
    title: p.title,
    finalUrl: p.final_url,
    errorMessage: p.error_message,
    waitTimedOut: p.wait_timed_out === 1,
    shots: shotsByPage.get(p.id) ?? [],
  }));
}

// V-05b: 2つの撮影結果のページをパスで組み合わせる。撮影できたページだけを対象にする
export function compareCrawls(a: CrawlRow, b: CrawlRow, store: Store): CompareResult {
  const pagesA = pageItems(a.id, store).filter((p) => p.status === 'done');
  const pagesB = pageItems(b.id, store).filter((p) => p.status === 'done');
  const byPathA = new Map(pagesA.map((p) => [p.path, p]));
  const byPathB = new Map(pagesB.map((p) => [p.path, p]));
  const keys = [...new Set([...byPathA.keys(), ...byPathB.keys()])].sort((x, y) => x.localeCompare(y, 'ja'));
  const pairs: ComparePair[] = keys.map((key) => {
    const pa = byPathA.get(key) ?? null;
    const pb = byPathB.get(key) ?? null;
    return { key, status: pa && pb ? 'both' : pb ? 'added' : 'removed', a: pa, b: pb };
  });
  const widthsA = JSON.parse(a.settings_json).viewports as number[];
  const widthsB = new Set(JSON.parse(b.settings_json).viewports as number[]);
  return {
    a: crawlSummary(a, store),
    b: crawlSummary(b, store),
    commonWidths: widthsA.filter((w) => widthsB.has(w)).sort((x, y) => y - x),
    pairs,
  };
}
