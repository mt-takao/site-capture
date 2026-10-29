// M0 技術検証: 検証用ページと Notion の公開ページを、各方式で撮って結果を比べる。
// 使い方: pnpm spike [URL ...]   （URL を省略すると検証用ページだけを撮る）
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { DOM_OBSERVER_INIT_SCRIPT, NetworkTracker, waitForStable, type StabilizeResult } from '../src/capture/stabilize.js';
import { findScrollTarget, scrollThrough, type ScrollTarget } from '../src/capture/scroll.js';
import { shootDocument, shootExpanded, shootStitched, type ShotResult } from '../src/capture/shoot.js';
import { injectCaptureStyles, TSX_COMPAT_INIT_SCRIPT } from '../src/capture/prepare.js';
import { detectBlocked } from '../src/capture/blocked.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'spike-output');

type Target = {
  name: string;
  url: string;
  hideSelectors?: string[];
  waitForSelector?: string;
  scrollContainerSelector?: string;
};

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 375, height: 812 },
];

function startFixtureServer(): Promise<{ origin: string; close: () => void }> {
  const server = createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/poll') {
      res.end('ok');
      return;
    }
    try {
      const body = await readFile(join(here, 'fixtures', path.replace(/^\//, '')));
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

type Method = 'auto' | 'expand' | 'stitch';

type RunRecord = {
  target: string;
  viewport: number;
  method: Method;
  status: number | null;
  stabilize: StabilizeResult;
  scrollTarget: ScrollTarget;
  scroll: { steps: number; finalScrollHeight: number; reachedEnd: boolean };
  shot: (ShotResult & { expandedFrom?: number }) | null;
  fellBack: boolean;
  totalMs: number;
  error?: string;
};

async function captureOnce(browser: Browser, target: Target, vp: { width: number; height: number }, method: Method): Promise<RunRecord> {
  const startedAt = Date.now();
  const context = await browser.newContext({ viewport: vp, deviceScaleFactor: 1, locale: 'ja-JP' });
  await context.addInitScript(TSX_COMPAT_INIT_SCRIPT);
  await context.addInitScript(DOM_OBSERVER_INIT_SCRIPT);
  const page = await context.newPage();
  const network = new NetworkTracker(page);
  const record: Partial<RunRecord> = { target: target.name, viewport: vp.width, method, fellBack: false };
  try {
    const res = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    record.status = res?.status() ?? null;
    await injectCaptureStyles(page, { hideSelectors: target.hideSelectors ?? [], disableAnimations: true });
    if (target.waitForSelector) await page.waitForSelector(target.waitForSelector, { timeout: 15000 });
    record.stabilize = await waitForStable(page, network, { quietWindowMs: 1000, maxWaitMs: 15000 });
    const blocked = await detectBlocked(page, record.status);
    if (blocked) throw new Error(`blocked: ${blocked}`);

    const scrollTarget = await findScrollTarget(page, target.scrollContainerSelector);
    record.scrollTarget = scrollTarget;
    record.scroll = await scrollThrough(page, scrollTarget);
    await waitForStable(page, network, { quietWindowMs: 500, maxWaitMs: 5000 });

    const file = join(outDir, target.name, `${method}__${vp.width}.png`);
    await mkdir(dirname(file), { recursive: true });
    if (scrollTarget.kind === 'document') {
      record.shot = await shootDocument(page, file);
    } else if (method === 'stitch') {
      record.shot = await shootStitched(page, scrollTarget, file);
    } else {
      const expanded = await shootExpanded(page, scrollTarget, file);
      if (expanded) {
        record.shot = expanded;
      } else {
        record.fellBack = true;
        // 展開に失敗したらページを読み込み直してつなぎ合わせ方式で撮る（展開でDOMを書き換えているため）
        await context.close();
        const retry = await captureOnce(browser, target, vp, 'stitch');
        return { ...retry, method, fellBack: true, totalMs: Date.now() - startedAt };
      }
    }
  } catch (e) {
    record.error = e instanceof Error ? e.message : String(e);
  } finally {
    await context.close().catch(() => {});
  }
  return { ...(record as RunRecord), totalMs: Date.now() - startedAt };
}

async function main() {
  const fixtures = await startFixtureServer();
  const onlyExternal = process.env.SPIKE_ONLY_EXTERNAL === '1';
  const targets: Target[] = [
    ...(onlyExternal ? [] : [
    { name: 'long-static', url: `${fixtures.origin}/long-static.html` },
    { name: 'spa-inner-scroll', url: `${fixtures.origin}/spa-inner-scroll.html`, hideSelectors: ['.banner'] },
    { name: 'spa-virtual', url: `${fixtures.origin}/spa-virtual.html` },
    { name: 'busy', url: `${fixtures.origin}/busy.html` },
    ]),
    ...process.argv.slice(2).map((url, i) => ({ name: `external-${i + 1}`, url })),
  ];

  const browser = await chromium.launch();
  const records: RunRecord[] = [];
  for (const target of targets) {
    for (const vp of VIEWPORTS) {
      for (const method of ['expand', 'stitch'] as const) {
        if (target.name.startsWith('external')) await new Promise((r) => setTimeout(r, 10000));
        const r = await captureOnce(browser, target, vp, method);
        records.push(r);
        console.log(
          [
            r.target.padEnd(18),
            String(r.viewport).padStart(4),
            method.padEnd(6),
            (r.scrollTarget?.kind ?? '-').padEnd(8),
            r.shot ? `${r.shot.method}${r.fellBack ? '(fallback)' : ''} ${r.shot.width}x${r.shot.height}` : `ERROR ${r.error}`,
            `wait=${r.stabilize?.elapsedMs}ms${r.stabilize?.timedOut ? ` TIMEOUT[${r.stabilize.unmet.join(',')}]` : ''}`,
            `total=${r.totalMs}ms`,
          ].join('  '),
        );
        // ページ全体のスクロールのページは方式による差がないので1回で十分
        if (r.scrollTarget?.kind === 'document') break;
      }
    }
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), JSON.stringify(records, null, 2));
  await browser.close();
  fixtures.close();
}

await main();
