import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SITE_SETTINGS, type SiteSettings } from '../capture/types.js';

// 設計書 6.5: 組み込みのサイト設定（プリセット）。サイトの作りが変わったときに直しやすいよう、中身は JSON に置く
const here = dirname(fileURLToPath(import.meta.url));

function loadPreset(file: string): SiteSettings {
  const raw = JSON.parse(readFileSync(join(here, file), 'utf8')) as Partial<SiteSettings>;
  return { ...DEFAULT_SITE_SETTINGS, ...raw };
}

export const BUILTIN_PRESETS: SiteSettings[] = [loadPreset('notion.json')];

// `*.example.com` はサブドメインすべてに当てはまる（example.com 自体は含まない）。それ以外は完全一致
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p;
}

export function findSiteSettings(url: string, candidates: SiteSettings[] = BUILTIN_PRESETS): SiteSettings {
  const host = new URL(url).hostname;
  return candidates.find((s) => s.hostPatterns.some((p) => hostMatches(host, p))) ?? DEFAULT_SITE_SETTINGS;
}
