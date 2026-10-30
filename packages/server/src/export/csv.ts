import type { PageItem } from '@site-capture/shared';
import { basename } from 'node:path';

// V-07: ページ一覧の CSV。Excel で文字化けしないよう、先頭に BOM を付けた UTF-8 にする

const statusLabel: Record<PageItem['status'], string> = {
  queued: '撮影待ち',
  capturing: '撮影中',
  done: '撮影済み',
  failed: '失敗',
  skipped: '対象外',
};

export function pagesCsv(pages: PageItem[], widths: number[], filePathOf: (shotId: number) => string | undefined): string {
  const header = ['URL', 'パス', 'タイトル', 'ステータスコード', '状態', '対象外の理由', 'エラー', '階層', '転送先', '待ちきれずに撮影', ...widths.map((w) => `画像（${w}px）`)];
  const rows = pages.map((p) => [
    p.url,
    p.path,
    p.title ?? '',
    p.httpStatus ?? '',
    statusLabel[p.status],
    p.skipReason ?? '',
    p.errorMessage ?? '',
    p.depth,
    p.finalUrl && p.finalUrl !== p.url ? p.finalUrl : '',
    p.waitTimedOut ? 'はい' : '',
    ...widths.map((w) => {
      const shot = p.shots.find((s) => s.viewportWidth === w);
      const path = shot ? filePathOf(shot.id) : undefined;
      return path ? basename(path) : '';
    }),
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
