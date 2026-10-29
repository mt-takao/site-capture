// Notion でつなぎ合わせ方式だけ画面が欠ける原因を調べる。1回の読み込みで各段階の画面と状態を記録する。
// 使い方: tsx spike/notion-debug.ts <URL>
import { mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Request } from 'playwright';
import { DOM_OBSERVER_INIT_SCRIPT, NetworkTracker, waitForStable } from '../src/capture/stabilize.js';
import { findScrollTarget, scrollThrough } from '../src/capture/scroll.js';
import { injectCaptureStyles, TSX_COMPAT_INIT_SCRIPT } from '../src/capture/prepare.js';
import { shootDocument, shootExpanded, shootStitched } from '../src/capture/shoot.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'spike-output', `notion-debug-${process.env.WIDTH ?? 1440}`);
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: Number(process.env.WIDTH ?? 1440), height: process.env.WIDTH === '375' ? 812 : 900 }, deviceScaleFactor: 1, locale: 'ja-JP' });
await context.addInitScript(TSX_COMPAT_INIT_SCRIPT);
await context.addInitScript(DOM_OBSERVER_INIT_SCRIPT);
const page = await context.newPage();
const network = new NetworkTracker(page);

const inflight = new Map<Request, number>();
page.on('request', (r) => inflight.set(r, Date.now()));
page.on('requestfinished', (r) => inflight.delete(r));
page.on('requestfailed', (r) => inflight.delete(r));
const dumpInflight = (label: string) =>
  console.log(label, [...inflight].map(([r, t]) => `${r.method()} ${r.resourceType()} ${r.url().slice(0, 100)} ${Date.now() - t}ms`));

const state = (label: string) =>
  page.evaluate(() => {
    const topEl = document.elementFromPoint(300, 20);
    return {
      topbar: topEl ? `${topEl.tagName}.${[...topEl.classList].join('.')}` : null,
      hasFocus: document.hasFocus(),
      visibility: document.visibilityState,
      imgs: Array.from(document.images).filter((i) => !i.complete).map((i) => i.src.slice(0, 80)),
    };
  }).then((s) => console.log(label, s));

const res = await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
console.log('status', res?.status());
await injectCaptureStyles(page, { hideSelectors: [], disableAnimations: true });
console.log('stable', await waitForStable(page, network, { quietWindowMs: 1000, maxWaitMs: 15000 }));
await page.screenshot({ path: join(outDir, 'a-stable.png') });
await state('a');

const target = await findScrollTarget(page);
console.log('target', target);
await scrollThrough(page, target);
await page.screenshot({ path: join(outDir, 'b-after-scroll.png') });
await state('b');

console.log('stable2', await waitForStable(page, network, { quietWindowMs: 500, maxWaitMs: 15000 }));
dumpInflight('inflight after stable2');
await page.screenshot({ path: join(outDir, 'c-stable2.png') });
await state('c');

if (target.kind === 'element') {
  console.log('stitch', await shootStitched(page, target, join(outDir, 'd-stitch.png')));
  await page.screenshot({ path: join(outDir, 'e-after-stitch.png') });
  await state('e');
  console.log('expand', await shootExpanded(page, target, join(outDir, 'f-expand.png')));
} else {
  console.log('document', await shootDocument(page, join(outDir, 'd-document.png')));
}
await browser.close();
