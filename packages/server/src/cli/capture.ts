// 1つのURLを複数の画面幅で撮って保存する（M1 の完了条件「コマンド1つで撮れる」）。
// 使い方: pnpm capture <URL> [--widths 1440,375] [--out <保存先>] [--expand-toggles] [--no-preset]
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { BlockedError } from '../capture/blocked.js';
import { capturePage, createCaptureContext } from '../capture/capture-page.js';
import { HostGate, withRateLimitRetry } from '../capture/host-gate.js';
import { DEFAULT_CAPTURE_OPTIONS, DEFAULT_SITE_SETTINGS, viewportForWidth } from '../capture/types.js';
import { findSiteSettings } from '../presets/index.js';
import { captureDir } from '../paths.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    widths: { type: 'string', default: '1440,375' },
    out: { type: 'string' },
    'expand-toggles': { type: 'boolean', default: false },
    'no-preset': { type: 'boolean', default: false },
  },
});

const url = positionals[0];
if (!url) {
  console.error('使い方: pnpm capture <URL> [--widths 1440,375] [--out <保存先>] [--expand-toggles] [--no-preset]');
  process.exit(2);
}

const host = new URL(url).hostname;
const widths = values.widths.split(',').map((w) => Number(w.trim())).filter((w) => w > 0);
const outDir = values.out ?? captureDir(host, new Date());
const site = values['no-preset'] ? DEFAULT_SITE_SETTINGS : findSiteSettings(url);
const options = { ...DEFAULT_CAPTURE_OPTIONS, expandToggles: values['expand-toggles'] };

console.log(`URL: ${url}`);
console.log(`サイト設定: ${site.name} / 画面幅: ${widths.join(', ')} / 保存先: ${outDir}`);

const browser = await chromium.launch();
const context = await createCaptureContext(browser);
const gate = new HostGate(site.intervalMs ?? 500);
const startedAt = Date.now();
try {
  const result = await withRateLimitRetry(
    gate,
    host,
    () =>
      capturePage({
        context,
        url,
        viewports: widths.map(viewportForWidth),
        outDir,
        options,
        site,
        log: (m) => console.log(`  ${m}`),
      }),
    ({ error, waitSec, attempt }) => console.log(`  アクセス制限（${error.reason}）のため ${waitSec}秒待って撮り直します（${attempt}回目）`),
  );
  console.log(`ステータス: ${result.httpStatus} / タイトル: ${result.title} / リンク: ${result.links.length}件`);
  for (const s of result.shots) {
    const notes = [s.fellBackToStitch ? 'つなぎ合わせ方式に切り替え' : '', s.waitTimedOut ? '待ちきれずに撮影' : '']
      .filter(Boolean)
      .join('、');
    console.log(`  ${s.viewportWidth}px: ${s.imageWidth}×${s.imageHeight} (${s.method})${notes ? ` ※${notes}` : ''} → ${s.filePath}`);
  }
  console.log(`所要時間: ${((Date.now() - startedAt) / 1000).toFixed(1)}秒`);
} catch (e) {
  const reason = e instanceof BlockedError ? `アクセス制限（${e.reason}）` : e instanceof Error ? e.message : String(e);
  console.error(`撮影に失敗しました: ${reason}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

