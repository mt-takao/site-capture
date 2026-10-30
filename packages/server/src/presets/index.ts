import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SITE_SETTINGS, type CrawlSettings, type SiteSettings, type SiteSettingsItem } from '@site-capture/shared';
import type { Store } from '../db/store.js';

// 設計書 6.5: 組み込みのサイト設定（プリセット）。サイトの作りが変わったときに直しやすいよう、中身は JSON に置く
const here = dirname(fileURLToPath(import.meta.url));

function loadPreset(id: string, file: string): SiteSettingsItem {
  const raw = JSON.parse(readFileSync(join(here, file), 'utf8')) as Partial<SiteSettings>;
  return { ...DEFAULT_SITE_SETTINGS, ...raw, id, builtin: true };
}

// どのサイト設定にも当てはまらないときに使う「標準」
export const DEFAULT_SITE_SETTINGS_ITEM: SiteSettingsItem = { ...DEFAULT_SITE_SETTINGS, id: 'builtin:default', builtin: true };

export const BUILTIN_PRESETS: SiteSettingsItem[] = [loadPreset('builtin:notion', 'notion.json')];

// `*.example.com` はサブドメインすべてに当てはまる（example.com 自体は含まない）。それ以外は完全一致
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

export function findSiteSettings(url: string, candidates: SiteSettingsItem[] = BUILTIN_PRESETS): SiteSettingsItem {
  const host = new URL(url).hostname;
  return candidates.find((s) => s.hostPatterns.some((p) => hostMatches(host, p))) ?? DEFAULT_SITE_SETTINGS_ITEM;
}

// 選べるサイト設定のすべて。利用者が作ったものを組み込みより先に並べ、自動で選ぶときも優先する
export function allSiteSettings(store: Store): SiteSettingsItem[] {
  return [...store.listSiteSettings(), ...BUILTIN_PRESETS, DEFAULT_SITE_SETTINGS_ITEM];
}

// 撮影に使うサイト設定を決める。ID の指定があればそれを、なければ起点URLから自動で選ぶ
export function resolveSiteSettings(store: Store, settings: Pick<CrawlSettings, 'startUrl' | 'siteSettingsId'>): SiteSettingsItem {
  const all = allSiteSettings(store);
  if (settings.siteSettingsId) {
    const chosen = all.find((s) => s.id === settings.siteSettingsId);
    if (chosen) return chosen;
  }
  return findSiteSettings(settings.startUrl, all.filter((s) => s !== DEFAULT_SITE_SETTINGS_ITEM));
}
